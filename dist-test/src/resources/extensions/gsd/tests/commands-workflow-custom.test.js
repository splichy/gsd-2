import { describe, it, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getGsdArgumentCompletions, TOP_LEVEL_SUBCOMMANDS } from "../commands/catalog.js";
const tmpDirs = [];
let savedCwd;
function makeTmpBase() {
  const dir = mkdtempSync(join(tmpdir(), "wf-cmd-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  if (savedCwd && process.cwd() !== savedCwd) {
    process.chdir(savedCwd);
  }
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  }
  tmpDirs.length = 0;
});
before(() => {
  savedCwd = process.cwd();
});
function createMockCtx() {
  const notifications = [];
  return {
    notifications,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      custom: async () => {
      }
    },
    shutdown: async () => {
    },
    sessionManager: {
      getSessionFile: () => null
    }
  };
}
function createMockPi() {
  return {
    registerCommand() {
    },
    registerTool() {
    },
    registerShortcut() {
    },
    on() {
    },
    sendMessage() {
    }
  };
}
function writeDefinition(basePath, name, content) {
  const defsDir = join(basePath, ".gsd", "workflow-defs");
  mkdirSync(defsDir, { recursive: true });
  writeFileSync(join(defsDir, `${name}.yaml`), content, "utf-8");
}
const SIMPLE_DEF = `
version: 1
name: test-workflow
description: A test workflow
steps:
  - id: step-1
    name: First Step
    prompt: Do step 1
    requires: []
    produces: []
`;
const INVALID_DEF = `
version: 2
name: bad-workflow
steps: []
`;
describe("workflow catalog registration", () => {
  it("model appears in TOP_LEVEL_SUBCOMMANDS", () => {
    const entry = TOP_LEVEL_SUBCOMMANDS.find((c) => c.cmd === "model");
    assert.ok(entry, "model should be in TOP_LEVEL_SUBCOMMANDS");
    assert.match(entry.desc, /session model/i);
  });
  it("getGsdArgumentCompletions('m') includes model", () => {
    const completions = getGsdArgumentCompletions("m");
    const labels = completions.map((c) => c.label);
    assert.ok(labels.includes("model"), "should include model completion");
  });
  it("workflow appears in TOP_LEVEL_SUBCOMMANDS", () => {
    const entry = TOP_LEVEL_SUBCOMMANDS.find((c) => c.cmd === "workflow");
    assert.ok(entry, "workflow should be in TOP_LEVEL_SUBCOMMANDS");
    assert.ok(entry.desc.includes("new"), "description should mention new");
    assert.ok(entry.desc.includes("run"), "description should mention run");
  });
  it("getGsdArgumentCompletions('workflow ') returns the full subcommand set", () => {
    const completions = getGsdArgumentCompletions("workflow ");
    const labels = completions.map((c) => c.label);
    for (const sub of [
      "new",
      "run",
      "list",
      "info",
      "install",
      "uninstall",
      "validate",
      "pause",
      "resume"
    ]) {
      assert.ok(labels.includes(sub), `missing completion: ${sub}`);
    }
    assert.equal(labels.length, 9, "should have exactly 9 subcommands");
  });
  it("getGsdArgumentCompletions('workflow r') filters to run and resume", () => {
    const completions = getGsdArgumentCompletions("workflow r");
    const labels = completions.map((c) => c.label);
    assert.ok(labels.includes("run"), "should include run");
    assert.ok(labels.includes("resume"), "should include resume");
    assert.ok(!labels.includes("list"), "should not include list");
  });
  it("getGsdArgumentCompletions('workflow run ') returns definition names", () => {
    const base = makeTmpBase();
    writeDefinition(base, "deploy-pipeline", SIMPLE_DEF);
    writeDefinition(base, "test-suite", SIMPLE_DEF);
    process.chdir(base);
    const completions = getGsdArgumentCompletions("workflow run ");
    const labels = completions.map((c) => c.label);
    assert.ok(labels.includes("deploy-pipeline"), "should include deploy-pipeline");
    assert.ok(labels.includes("test-suite"), "should include test-suite");
  });
  it("getGsdArgumentCompletions('workflow validate ') returns definition names", () => {
    const base = makeTmpBase();
    writeDefinition(base, "my-workflow", SIMPLE_DEF);
    process.chdir(base);
    const completions = getGsdArgumentCompletions("workflow validate ");
    const labels = completions.map((c) => c.label);
    assert.ok(labels.includes("my-workflow"), "should include my-workflow");
  });
  it("getGsdArgumentCompletions('workflow run d') filters by prefix", () => {
    const base = makeTmpBase();
    writeDefinition(base, "deploy-pipeline", SIMPLE_DEF);
    writeDefinition(base, "test-suite", SIMPLE_DEF);
    process.chdir(base);
    const completions = getGsdArgumentCompletions("workflow run d");
    const labels = completions.map((c) => c.label);
    assert.ok(labels.includes("deploy-pipeline"), "should include deploy-pipeline");
    assert.ok(!labels.includes("test-suite"), "should not include test-suite");
  });
});
describe("workflow command handler", () => {
  async function callHandler(trimmed) {
    const { handleWorkflowCommand } = await import("../commands/handlers/workflow.js");
    const ctx = createMockCtx();
    const pi = createMockPi();
    const handled = await handleWorkflowCommand(trimmed, ctx, pi);
    return { handled, notifications: ctx.notifications };
  }
  it("bare '/gsd workflow' lists plugins grouped by mode", async () => {
    const { handled, notifications } = await callHandler("workflow");
    assert.ok(handled, "should be handled");
    assert.ok(
      notifications.some((n) => n.message.includes("Workflow Plugins")),
      "should list plugins"
    );
  });
  it("'/gsd workflow new' shows skill invocation message", async () => {
    const { handled, notifications } = await callHandler("workflow new");
    assert.ok(handled, "should be handled");
    assert.ok(
      notifications.some((n) => n.message.includes("create-workflow")),
      "should mention create-workflow skill"
    );
  });
  it("'/gsd workflow run' without name shows usage warning", async () => {
    const { handled, notifications } = await callHandler("workflow run");
    assert.ok(handled, "should be handled");
    assert.ok(
      notifications.some((n) => n.level === "warning" && n.message.includes("Usage")),
      "should show usage warning"
    );
  });
  it("preserves quoted workflow run overrides (#4130)", async () => {
    const { parseWorkflowRunArgs } = await import("../commands/handlers/workflow.js");
    assert.deepStrictEqual(
      parseWorkflowRunArgs(`demo-workflow target="multi word target" region='us east'`),
      {
        defName: "demo-workflow",
        overrides: {
          target: "multi word target",
          region: "us east"
        }
      }
    );
  });
  it("'/gsd workflow run nonexistent' shows error for missing definition", async () => {
    const { handled, notifications } = await callHandler("workflow run nonexistent-def-12345");
    assert.ok(handled, "should be handled");
    assert.ok(
      notifications.some((n) => n.level === "error" && n.message.includes("not found")),
      "should show definition-not-found error"
    );
  });
  it("'/gsd workflow validate' without name shows usage warning", async () => {
    const { handled, notifications } = await callHandler("workflow validate");
    assert.ok(handled, "should be handled");
    assert.ok(
      notifications.some((n) => n.level === "warning" && n.message.includes("Usage")),
      "should show usage warning"
    );
  });
  it("'/gsd workflow validate nonexistent' shows definition not found", async () => {
    const { handled, notifications } = await callHandler("workflow validate nonexistent-def-12345");
    assert.ok(handled, "should be handled");
    assert.ok(
      notifications.some((n) => n.level === "error" && n.message.includes("not found")),
      "should show not-found error"
    );
  });
  it("'/gsd workflow pause' without custom engine shows warning", async () => {
    const { handled, notifications } = await callHandler("workflow pause");
    assert.ok(handled, "should be handled");
    assert.ok(
      notifications.some((n) => n.level === "warning"),
      "should show warning when no custom workflow is running"
    );
  });
  it("'/gsd workflow resume' without custom engine shows warning", async () => {
    const { handled, notifications } = await callHandler("workflow resume");
    assert.ok(handled, "should be handled");
    assert.ok(
      notifications.some((n) => n.level === "warning"),
      "should show warning when no custom workflow to resume"
    );
  });
  it("'/gsd workflow unknown-sub' shows unknown subcommand", async () => {
    const { handled, notifications } = await callHandler("workflow blurble");
    assert.ok(handled, "should be handled");
    assert.ok(
      notifications.some((n) => n.message.includes("Unknown workflow subcommand")),
      "should show unknown subcommand message"
    );
  });
  it("'/gsd workflow list' with no runs shows empty message", async () => {
    const { handled, notifications } = await callHandler("workflow list");
    assert.ok(handled, "should be handled");
    assert.ok(
      notifications.some((n) => n.message.includes("No workflow runs found")),
      "should show no runs message"
    );
  });
  it("non-workflow commands are not intercepted by custom workflow routing", async () => {
    const { handleWorkflowCommand } = await import("../commands/handlers/workflow.js");
    const ctx = createMockCtx();
    const pi = createMockPi();
    const handled = await handleWorkflowCommand("somethingelse", ctx, pi);
    assert.equal(handled, false, "non-workflow commands should return false");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb21tYW5kcy13b3JrZmxvdy1jdXN0b20udGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBjb21tYW5kcy13b3JrZmxvdy1jdXN0b20udGVzdC50cyBcdTIwMTQgVGVzdHMgZm9yIGAvZ3NkIHdvcmtmbG93YCBzdWJjb21tYW5kc1xuICogYW5kIGNhdGFsb2cgY29tcGxldGlvbnMuXG4gKlxuICogVXNlcyByZWFsIHRlbXAgZGlyZWN0b3JpZXMgd2l0aCBhY3R1YWwgZGVmaW5pdGlvbiBZQU1MIGZpbGVzLlxuICovXG5cbmltcG9ydCB7IGRlc2NyaWJlLCBpdCwgYWZ0ZXJFYWNoLCBiZWZvcmUgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7XG4gIG1rZHRlbXBTeW5jLFxuICBybVN5bmMsXG4gIG1rZGlyU3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbiAgZXhpc3RzU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyBnZXRHc2RBcmd1bWVudENvbXBsZXRpb25zLCBUT1BfTEVWRUxfU1VCQ09NTUFORFMgfSBmcm9tIFwiLi4vY29tbWFuZHMvY2F0YWxvZy50c1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc3QgdG1wRGlyczogc3RyaW5nW10gPSBbXTtcbmxldCBzYXZlZEN3ZDogc3RyaW5nO1xuXG5mdW5jdGlvbiBtYWtlVG1wQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBkaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcIndmLWNtZC10ZXN0LVwiKSk7XG4gIHRtcERpcnMucHVzaChkaXIpO1xuICByZXR1cm4gZGlyO1xufVxuXG5hZnRlckVhY2goKCkgPT4ge1xuICAvLyBSZXN0b3JlIGN3ZCBpZiBjaGFuZ2VkIGR1cmluZyB0ZXN0c1xuICBpZiAoc2F2ZWRDd2QgJiYgcHJvY2Vzcy5jd2QoKSAhPT0gc2F2ZWRDd2QpIHtcbiAgICBwcm9jZXNzLmNoZGlyKHNhdmVkQ3dkKTtcbiAgfVxuICBmb3IgKGNvbnN0IGQgb2YgdG1wRGlycykge1xuICAgIHRyeSB7IHJtU3luYyhkLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUsIG1heFJldHJpZXM6IDMsIHJldHJ5RGVsYXk6IDEwMCB9KTsgfSBjYXRjaCB7IC8qIFdpbmRvd3MgRVBFUk0gKi8gfVxuICB9XG4gIHRtcERpcnMubGVuZ3RoID0gMDtcbn0pO1xuXG5iZWZvcmUoKCkgPT4ge1xuICBzYXZlZEN3ZCA9IHByb2Nlc3MuY3dkKCk7XG59KTtcblxuZnVuY3Rpb24gY3JlYXRlTW9ja0N0eCgpIHtcbiAgY29uc3Qgbm90aWZpY2F0aW9uczogeyBtZXNzYWdlOiBzdHJpbmc7IGxldmVsOiBzdHJpbmcgfVtdID0gW107XG4gIHJldHVybiB7XG4gICAgbm90aWZpY2F0aW9ucyxcbiAgICB1aToge1xuICAgICAgbm90aWZ5KG1lc3NhZ2U6IHN0cmluZywgbGV2ZWw6IHN0cmluZykge1xuICAgICAgICBub3RpZmljYXRpb25zLnB1c2goeyBtZXNzYWdlLCBsZXZlbCB9KTtcbiAgICAgIH0sXG4gICAgICBjdXN0b206IGFzeW5jICgpID0+IHt9LFxuICAgIH0sXG4gICAgc2h1dGRvd246IGFzeW5jICgpID0+IHt9LFxuICAgIHNlc3Npb25NYW5hZ2VyOiB7XG4gICAgICBnZXRTZXNzaW9uRmlsZTogKCkgPT4gbnVsbCxcbiAgICB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiBjcmVhdGVNb2NrUGkoKSB7XG4gIHJldHVybiB7XG4gICAgcmVnaXN0ZXJDb21tYW5kKCkge30sXG4gICAgcmVnaXN0ZXJUb29sKCkge30sXG4gICAgcmVnaXN0ZXJTaG9ydGN1dCgpIHt9LFxuICAgIG9uKCkge30sXG4gICAgc2VuZE1lc3NhZ2UoKSB7fSxcbiAgfTtcbn1cblxuLyoqIFdyaXRlIGEgbWluaW1hbCB2YWxpZCB3b3JrZmxvdyBkZWZpbml0aW9uIFlBTUwgdG8gdGhlIGV4cGVjdGVkIGxvY2F0aW9uLiAqL1xuZnVuY3Rpb24gd3JpdGVEZWZpbml0aW9uKGJhc2VQYXRoOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGRlZnNEaXIgPSBqb2luKGJhc2VQYXRoLCBcIi5nc2RcIiwgXCJ3b3JrZmxvdy1kZWZzXCIpO1xuICBta2RpclN5bmMoZGVmc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkZWZzRGlyLCBgJHtuYW1lfS55YW1sYCksIGNvbnRlbnQsIFwidXRmLThcIik7XG59XG5cbmNvbnN0IFNJTVBMRV9ERUYgPSBgXG52ZXJzaW9uOiAxXG5uYW1lOiB0ZXN0LXdvcmtmbG93XG5kZXNjcmlwdGlvbjogQSB0ZXN0IHdvcmtmbG93XG5zdGVwczpcbiAgLSBpZDogc3RlcC0xXG4gICAgbmFtZTogRmlyc3QgU3RlcFxuICAgIHByb21wdDogRG8gc3RlcCAxXG4gICAgcmVxdWlyZXM6IFtdXG4gICAgcHJvZHVjZXM6IFtdXG5gO1xuXG5jb25zdCBJTlZBTElEX0RFRiA9IGBcbnZlcnNpb246IDJcbm5hbWU6IGJhZC13b3JrZmxvd1xuc3RlcHM6IFtdXG5gO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ2F0YWxvZyBSZWdpc3RyYXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwid29ya2Zsb3cgY2F0YWxvZyByZWdpc3RyYXRpb25cIiwgKCkgPT4ge1xuICBpdChcIm1vZGVsIGFwcGVhcnMgaW4gVE9QX0xFVkVMX1NVQkNPTU1BTkRTXCIsICgpID0+IHtcbiAgICBjb25zdCBlbnRyeSA9IFRPUF9MRVZFTF9TVUJDT01NQU5EUy5maW5kKChjKSA9PiBjLmNtZCA9PT0gXCJtb2RlbFwiKTtcbiAgICBhc3NlcnQub2soZW50cnksIFwibW9kZWwgc2hvdWxkIGJlIGluIFRPUF9MRVZFTF9TVUJDT01NQU5EU1wiKTtcbiAgICBhc3NlcnQubWF0Y2goZW50cnkhLmRlc2MsIC9zZXNzaW9uIG1vZGVsL2kpO1xuICB9KTtcblxuICBpdChcImdldEdzZEFyZ3VtZW50Q29tcGxldGlvbnMoJ20nKSBpbmNsdWRlcyBtb2RlbFwiLCAoKSA9PiB7XG4gICAgY29uc3QgY29tcGxldGlvbnMgPSBnZXRHc2RBcmd1bWVudENvbXBsZXRpb25zKFwibVwiKTtcbiAgICBjb25zdCBsYWJlbHMgPSBjb21wbGV0aW9ucy5tYXAoKGM6IGFueSkgPT4gYy5sYWJlbCk7XG4gICAgYXNzZXJ0Lm9rKGxhYmVscy5pbmNsdWRlcyhcIm1vZGVsXCIpLCBcInNob3VsZCBpbmNsdWRlIG1vZGVsIGNvbXBsZXRpb25cIik7XG4gIH0pO1xuXG4gIGl0KFwid29ya2Zsb3cgYXBwZWFycyBpbiBUT1BfTEVWRUxfU1VCQ09NTUFORFNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGVudHJ5ID0gVE9QX0xFVkVMX1NVQkNPTU1BTkRTLmZpbmQoKGMpID0+IGMuY21kID09PSBcIndvcmtmbG93XCIpO1xuICAgIGFzc2VydC5vayhlbnRyeSwgXCJ3b3JrZmxvdyBzaG91bGQgYmUgaW4gVE9QX0xFVkVMX1NVQkNPTU1BTkRTXCIpO1xuICAgIGFzc2VydC5vayhlbnRyeSEuZGVzYy5pbmNsdWRlcyhcIm5ld1wiKSwgXCJkZXNjcmlwdGlvbiBzaG91bGQgbWVudGlvbiBuZXdcIik7XG4gICAgYXNzZXJ0Lm9rKGVudHJ5IS5kZXNjLmluY2x1ZGVzKFwicnVuXCIpLCBcImRlc2NyaXB0aW9uIHNob3VsZCBtZW50aW9uIHJ1blwiKTtcbiAgfSk7XG5cbiAgaXQoXCJnZXRHc2RBcmd1bWVudENvbXBsZXRpb25zKCd3b3JrZmxvdyAnKSByZXR1cm5zIHRoZSBmdWxsIHN1YmNvbW1hbmQgc2V0XCIsICgpID0+IHtcbiAgICBjb25zdCBjb21wbGV0aW9ucyA9IGdldEdzZEFyZ3VtZW50Q29tcGxldGlvbnMoXCJ3b3JrZmxvdyBcIik7XG4gICAgY29uc3QgbGFiZWxzID0gY29tcGxldGlvbnMubWFwKChjOiBhbnkpID0+IGMubGFiZWwpO1xuICAgIGZvciAoY29uc3Qgc3ViIG9mIFtcbiAgICAgIFwibmV3XCIsIFwicnVuXCIsIFwibGlzdFwiLCBcImluZm9cIiwgXCJpbnN0YWxsXCIsIFwidW5pbnN0YWxsXCIsIFwidmFsaWRhdGVcIiwgXCJwYXVzZVwiLCBcInJlc3VtZVwiLFxuICAgIF0pIHtcbiAgICAgIGFzc2VydC5vayhsYWJlbHMuaW5jbHVkZXMoc3ViKSwgYG1pc3NpbmcgY29tcGxldGlvbjogJHtzdWJ9YCk7XG4gICAgfVxuICAgIGFzc2VydC5lcXVhbChsYWJlbHMubGVuZ3RoLCA5LCBcInNob3VsZCBoYXZlIGV4YWN0bHkgOSBzdWJjb21tYW5kc1wiKTtcbiAgfSk7XG5cbiAgaXQoXCJnZXRHc2RBcmd1bWVudENvbXBsZXRpb25zKCd3b3JrZmxvdyByJykgZmlsdGVycyB0byBydW4gYW5kIHJlc3VtZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgY29tcGxldGlvbnMgPSBnZXRHc2RBcmd1bWVudENvbXBsZXRpb25zKFwid29ya2Zsb3cgclwiKTtcbiAgICBjb25zdCBsYWJlbHMgPSBjb21wbGV0aW9ucy5tYXAoKGM6IGFueSkgPT4gYy5sYWJlbCk7XG4gICAgYXNzZXJ0Lm9rKGxhYmVscy5pbmNsdWRlcyhcInJ1blwiKSwgXCJzaG91bGQgaW5jbHVkZSBydW5cIik7XG4gICAgYXNzZXJ0Lm9rKGxhYmVscy5pbmNsdWRlcyhcInJlc3VtZVwiKSwgXCJzaG91bGQgaW5jbHVkZSByZXN1bWVcIik7XG4gICAgYXNzZXJ0Lm9rKCFsYWJlbHMuaW5jbHVkZXMoXCJsaXN0XCIpLCBcInNob3VsZCBub3QgaW5jbHVkZSBsaXN0XCIpO1xuICB9KTtcblxuICBpdChcImdldEdzZEFyZ3VtZW50Q29tcGxldGlvbnMoJ3dvcmtmbG93IHJ1biAnKSByZXR1cm5zIGRlZmluaXRpb24gbmFtZXNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICAgIHdyaXRlRGVmaW5pdGlvbihiYXNlLCBcImRlcGxveS1waXBlbGluZVwiLCBTSU1QTEVfREVGKTtcbiAgICB3cml0ZURlZmluaXRpb24oYmFzZSwgXCJ0ZXN0LXN1aXRlXCIsIFNJTVBMRV9ERUYpO1xuXG4gICAgLy8gQ2hhbmdlIGN3ZCBzbyB0aGUgY29tcGxldGlvbiBzY2FubmVyIGNhbiBmaW5kIGAuZ3NkL3dvcmtmbG93LWRlZnMvYFxuICAgIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgICBjb25zdCBjb21wbGV0aW9ucyA9IGdldEdzZEFyZ3VtZW50Q29tcGxldGlvbnMoXCJ3b3JrZmxvdyBydW4gXCIpO1xuICAgIGNvbnN0IGxhYmVscyA9IGNvbXBsZXRpb25zLm1hcCgoYzogYW55KSA9PiBjLmxhYmVsKTtcbiAgICBhc3NlcnQub2sobGFiZWxzLmluY2x1ZGVzKFwiZGVwbG95LXBpcGVsaW5lXCIpLCBcInNob3VsZCBpbmNsdWRlIGRlcGxveS1waXBlbGluZVwiKTtcbiAgICBhc3NlcnQub2sobGFiZWxzLmluY2x1ZGVzKFwidGVzdC1zdWl0ZVwiKSwgXCJzaG91bGQgaW5jbHVkZSB0ZXN0LXN1aXRlXCIpO1xuICB9KTtcblxuICBpdChcImdldEdzZEFyZ3VtZW50Q29tcGxldGlvbnMoJ3dvcmtmbG93IHZhbGlkYXRlICcpIHJldHVybnMgZGVmaW5pdGlvbiBuYW1lc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gICAgd3JpdGVEZWZpbml0aW9uKGJhc2UsIFwibXktd29ya2Zsb3dcIiwgU0lNUExFX0RFRik7XG5cbiAgICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gICAgY29uc3QgY29tcGxldGlvbnMgPSBnZXRHc2RBcmd1bWVudENvbXBsZXRpb25zKFwid29ya2Zsb3cgdmFsaWRhdGUgXCIpO1xuICAgIGNvbnN0IGxhYmVscyA9IGNvbXBsZXRpb25zLm1hcCgoYzogYW55KSA9PiBjLmxhYmVsKTtcbiAgICBhc3NlcnQub2sobGFiZWxzLmluY2x1ZGVzKFwibXktd29ya2Zsb3dcIiksIFwic2hvdWxkIGluY2x1ZGUgbXktd29ya2Zsb3dcIik7XG4gIH0pO1xuXG4gIGl0KFwiZ2V0R3NkQXJndW1lbnRDb21wbGV0aW9ucygnd29ya2Zsb3cgcnVuIGQnKSBmaWx0ZXJzIGJ5IHByZWZpeFwiLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gICAgd3JpdGVEZWZpbml0aW9uKGJhc2UsIFwiZGVwbG95LXBpcGVsaW5lXCIsIFNJTVBMRV9ERUYpO1xuICAgIHdyaXRlRGVmaW5pdGlvbihiYXNlLCBcInRlc3Qtc3VpdGVcIiwgU0lNUExFX0RFRik7XG5cbiAgICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gICAgY29uc3QgY29tcGxldGlvbnMgPSBnZXRHc2RBcmd1bWVudENvbXBsZXRpb25zKFwid29ya2Zsb3cgcnVuIGRcIik7XG4gICAgY29uc3QgbGFiZWxzID0gY29tcGxldGlvbnMubWFwKChjOiBhbnkpID0+IGMubGFiZWwpO1xuICAgIGFzc2VydC5vayhsYWJlbHMuaW5jbHVkZXMoXCJkZXBsb3ktcGlwZWxpbmVcIiksIFwic2hvdWxkIGluY2x1ZGUgZGVwbG95LXBpcGVsaW5lXCIpO1xuICAgIGFzc2VydC5vayghbGFiZWxzLmluY2x1ZGVzKFwidGVzdC1zdWl0ZVwiKSwgXCJzaG91bGQgbm90IGluY2x1ZGUgdGVzdC1zdWl0ZVwiKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIENvbW1hbmQgSGFuZGxlciBUZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJ3b3JrZmxvdyBjb21tYW5kIGhhbmRsZXJcIiwgKCkgPT4ge1xuICAvLyBEeW5hbWljYWxseSBpbXBvcnQgdGhlIGhhbmRsZXIgc28gbW9kdWxlLWxldmVsIHNpZGUgZWZmZWN0c1xuICAvLyBkb24ndCBicmVhayB3aGVuIGF1dG8udHMgcHVsbHMgaW4gaGVhdnkgcnVudGltZSBkZXBzLlxuICAvLyBXZSB0ZXN0IHRoZSBwdXJlIHJvdXRpbmcgbG9naWMgYnkgY2FsbGluZyBoYW5kbGVXb3JrZmxvd0NvbW1hbmQgZGlyZWN0bHkuXG5cbiAgYXN5bmMgZnVuY3Rpb24gY2FsbEhhbmRsZXIodHJpbW1lZDogc3RyaW5nKSB7XG4gICAgY29uc3QgeyBoYW5kbGVXb3JrZmxvd0NvbW1hbmQgfSA9IGF3YWl0IGltcG9ydChcIi4uL2NvbW1hbmRzL2hhbmRsZXJzL3dvcmtmbG93LnRzXCIpO1xuICAgIGNvbnN0IGN0eCA9IGNyZWF0ZU1vY2tDdHgoKTtcbiAgICBjb25zdCBwaSA9IGNyZWF0ZU1vY2tQaSgpO1xuICAgIGNvbnN0IGhhbmRsZWQgPSBhd2FpdCBoYW5kbGVXb3JrZmxvd0NvbW1hbmQodHJpbW1lZCwgY3R4IGFzIGFueSwgcGkgYXMgYW55KTtcbiAgICByZXR1cm4geyBoYW5kbGVkLCBub3RpZmljYXRpb25zOiBjdHgubm90aWZpY2F0aW9ucyB9O1xuICB9XG5cbiAgaXQoXCJiYXJlICcvZ3NkIHdvcmtmbG93JyBsaXN0cyBwbHVnaW5zIGdyb3VwZWQgYnkgbW9kZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBoYW5kbGVkLCBub3RpZmljYXRpb25zIH0gPSBhd2FpdCBjYWxsSGFuZGxlcihcIndvcmtmbG93XCIpO1xuICAgIGFzc2VydC5vayhoYW5kbGVkLCBcInNob3VsZCBiZSBoYW5kbGVkXCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIG5vdGlmaWNhdGlvbnMuc29tZSgobikgPT4gbi5tZXNzYWdlLmluY2x1ZGVzKFwiV29ya2Zsb3cgUGx1Z2luc1wiKSksXG4gICAgICBcInNob3VsZCBsaXN0IHBsdWdpbnNcIixcbiAgICApO1xuICB9KTtcblxuICBpdChcIicvZ3NkIHdvcmtmbG93IG5ldycgc2hvd3Mgc2tpbGwgaW52b2NhdGlvbiBtZXNzYWdlXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IGhhbmRsZWQsIG5vdGlmaWNhdGlvbnMgfSA9IGF3YWl0IGNhbGxIYW5kbGVyKFwid29ya2Zsb3cgbmV3XCIpO1xuICAgIGFzc2VydC5vayhoYW5kbGVkLCBcInNob3VsZCBiZSBoYW5kbGVkXCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIG5vdGlmaWNhdGlvbnMuc29tZSgobikgPT4gbi5tZXNzYWdlLmluY2x1ZGVzKFwiY3JlYXRlLXdvcmtmbG93XCIpKSxcbiAgICAgIFwic2hvdWxkIG1lbnRpb24gY3JlYXRlLXdvcmtmbG93IHNraWxsXCIsXG4gICAgKTtcbiAgfSk7XG5cbiAgaXQoXCInL2dzZCB3b3JrZmxvdyBydW4nIHdpdGhvdXQgbmFtZSBzaG93cyB1c2FnZSB3YXJuaW5nXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IGhhbmRsZWQsIG5vdGlmaWNhdGlvbnMgfSA9IGF3YWl0IGNhbGxIYW5kbGVyKFwid29ya2Zsb3cgcnVuXCIpO1xuICAgIGFzc2VydC5vayhoYW5kbGVkLCBcInNob3VsZCBiZSBoYW5kbGVkXCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIG5vdGlmaWNhdGlvbnMuc29tZSgobikgPT4gbi5sZXZlbCA9PT0gXCJ3YXJuaW5nXCIgJiYgbi5tZXNzYWdlLmluY2x1ZGVzKFwiVXNhZ2VcIikpLFxuICAgICAgXCJzaG91bGQgc2hvdyB1c2FnZSB3YXJuaW5nXCIsXG4gICAgKTtcbiAgfSk7XG5cbiAgaXQoXCJwcmVzZXJ2ZXMgcXVvdGVkIHdvcmtmbG93IHJ1biBvdmVycmlkZXMgKCM0MTMwKVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBwYXJzZVdvcmtmbG93UnVuQXJncyB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vY29tbWFuZHMvaGFuZGxlcnMvd29ya2Zsb3cudHNcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChcbiAgICAgIHBhcnNlV29ya2Zsb3dSdW5BcmdzKCdkZW1vLXdvcmtmbG93IHRhcmdldD1cIm11bHRpIHdvcmQgdGFyZ2V0XCIgcmVnaW9uPVxcJ3VzIGVhc3RcXCcnKSxcbiAgICAgIHtcbiAgICAgICAgZGVmTmFtZTogXCJkZW1vLXdvcmtmbG93XCIsXG4gICAgICAgIG92ZXJyaWRlczoge1xuICAgICAgICAgIHRhcmdldDogXCJtdWx0aSB3b3JkIHRhcmdldFwiLFxuICAgICAgICAgIHJlZ2lvbjogXCJ1cyBlYXN0XCIsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICk7XG4gIH0pO1xuXG4gIGl0KFwiJy9nc2Qgd29ya2Zsb3cgcnVuIG5vbmV4aXN0ZW50JyBzaG93cyBlcnJvciBmb3IgbWlzc2luZyBkZWZpbml0aW9uXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IGhhbmRsZWQsIG5vdGlmaWNhdGlvbnMgfSA9IGF3YWl0IGNhbGxIYW5kbGVyKFwid29ya2Zsb3cgcnVuIG5vbmV4aXN0ZW50LWRlZi0xMjM0NVwiKTtcbiAgICBhc3NlcnQub2soaGFuZGxlZCwgXCJzaG91bGQgYmUgaGFuZGxlZFwiKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBub3RpZmljYXRpb25zLnNvbWUoKG4pID0+IG4ubGV2ZWwgPT09IFwiZXJyb3JcIiAmJiBuLm1lc3NhZ2UuaW5jbHVkZXMoXCJub3QgZm91bmRcIikpLFxuICAgICAgXCJzaG91bGQgc2hvdyBkZWZpbml0aW9uLW5vdC1mb3VuZCBlcnJvclwiLFxuICAgICk7XG4gIH0pO1xuXG4gIGl0KFwiJy9nc2Qgd29ya2Zsb3cgdmFsaWRhdGUnIHdpdGhvdXQgbmFtZSBzaG93cyB1c2FnZSB3YXJuaW5nXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IGhhbmRsZWQsIG5vdGlmaWNhdGlvbnMgfSA9IGF3YWl0IGNhbGxIYW5kbGVyKFwid29ya2Zsb3cgdmFsaWRhdGVcIik7XG4gICAgYXNzZXJ0Lm9rKGhhbmRsZWQsIFwic2hvdWxkIGJlIGhhbmRsZWRcIik7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgbm90aWZpY2F0aW9ucy5zb21lKChuKSA9PiBuLmxldmVsID09PSBcIndhcm5pbmdcIiAmJiBuLm1lc3NhZ2UuaW5jbHVkZXMoXCJVc2FnZVwiKSksXG4gICAgICBcInNob3VsZCBzaG93IHVzYWdlIHdhcm5pbmdcIixcbiAgICApO1xuICB9KTtcblxuICBpdChcIicvZ3NkIHdvcmtmbG93IHZhbGlkYXRlIG5vbmV4aXN0ZW50JyBzaG93cyBkZWZpbml0aW9uIG5vdCBmb3VuZFwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBoYW5kbGVkLCBub3RpZmljYXRpb25zIH0gPSBhd2FpdCBjYWxsSGFuZGxlcihcIndvcmtmbG93IHZhbGlkYXRlIG5vbmV4aXN0ZW50LWRlZi0xMjM0NVwiKTtcbiAgICBhc3NlcnQub2soaGFuZGxlZCwgXCJzaG91bGQgYmUgaGFuZGxlZFwiKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBub3RpZmljYXRpb25zLnNvbWUoKG4pID0+IG4ubGV2ZWwgPT09IFwiZXJyb3JcIiAmJiBuLm1lc3NhZ2UuaW5jbHVkZXMoXCJub3QgZm91bmRcIikpLFxuICAgICAgXCJzaG91bGQgc2hvdyBub3QtZm91bmQgZXJyb3JcIixcbiAgICApO1xuICB9KTtcblxuICBpdChcIicvZ3NkIHdvcmtmbG93IHBhdXNlJyB3aXRob3V0IGN1c3RvbSBlbmdpbmUgc2hvd3Mgd2FybmluZ1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBoYW5kbGVkLCBub3RpZmljYXRpb25zIH0gPSBhd2FpdCBjYWxsSGFuZGxlcihcIndvcmtmbG93IHBhdXNlXCIpO1xuICAgIGFzc2VydC5vayhoYW5kbGVkLCBcInNob3VsZCBiZSBoYW5kbGVkXCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIG5vdGlmaWNhdGlvbnMuc29tZSgobikgPT4gbi5sZXZlbCA9PT0gXCJ3YXJuaW5nXCIpLFxuICAgICAgXCJzaG91bGQgc2hvdyB3YXJuaW5nIHdoZW4gbm8gY3VzdG9tIHdvcmtmbG93IGlzIHJ1bm5pbmdcIixcbiAgICApO1xuICB9KTtcblxuICBpdChcIicvZ3NkIHdvcmtmbG93IHJlc3VtZScgd2l0aG91dCBjdXN0b20gZW5naW5lIHNob3dzIHdhcm5pbmdcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgaGFuZGxlZCwgbm90aWZpY2F0aW9ucyB9ID0gYXdhaXQgY2FsbEhhbmRsZXIoXCJ3b3JrZmxvdyByZXN1bWVcIik7XG4gICAgYXNzZXJ0Lm9rKGhhbmRsZWQsIFwic2hvdWxkIGJlIGhhbmRsZWRcIik7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgbm90aWZpY2F0aW9ucy5zb21lKChuKSA9PiBuLmxldmVsID09PSBcIndhcm5pbmdcIiksXG4gICAgICBcInNob3VsZCBzaG93IHdhcm5pbmcgd2hlbiBubyBjdXN0b20gd29ya2Zsb3cgdG8gcmVzdW1lXCIsXG4gICAgKTtcbiAgfSk7XG5cbiAgaXQoXCInL2dzZCB3b3JrZmxvdyB1bmtub3duLXN1Yicgc2hvd3MgdW5rbm93biBzdWJjb21tYW5kXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IGhhbmRsZWQsIG5vdGlmaWNhdGlvbnMgfSA9IGF3YWl0IGNhbGxIYW5kbGVyKFwid29ya2Zsb3cgYmx1cmJsZVwiKTtcbiAgICBhc3NlcnQub2soaGFuZGxlZCwgXCJzaG91bGQgYmUgaGFuZGxlZFwiKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBub3RpZmljYXRpb25zLnNvbWUoKG4pID0+IG4ubWVzc2FnZS5pbmNsdWRlcyhcIlVua25vd24gd29ya2Zsb3cgc3ViY29tbWFuZFwiKSksXG4gICAgICBcInNob3VsZCBzaG93IHVua25vd24gc3ViY29tbWFuZCBtZXNzYWdlXCIsXG4gICAgKTtcbiAgfSk7XG5cbiAgaXQoXCInL2dzZCB3b3JrZmxvdyBsaXN0JyB3aXRoIG5vIHJ1bnMgc2hvd3MgZW1wdHkgbWVzc2FnZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBoYW5kbGVkLCBub3RpZmljYXRpb25zIH0gPSBhd2FpdCBjYWxsSGFuZGxlcihcIndvcmtmbG93IGxpc3RcIik7XG4gICAgYXNzZXJ0Lm9rKGhhbmRsZWQsIFwic2hvdWxkIGJlIGhhbmRsZWRcIik7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgbm90aWZpY2F0aW9ucy5zb21lKChuKSA9PiBuLm1lc3NhZ2UuaW5jbHVkZXMoXCJObyB3b3JrZmxvdyBydW5zIGZvdW5kXCIpKSxcbiAgICAgIFwic2hvdWxkIHNob3cgbm8gcnVucyBtZXNzYWdlXCIsXG4gICAgKTtcbiAgfSk7XG5cbiAgaXQoXCJub24td29ya2Zsb3cgY29tbWFuZHMgYXJlIG5vdCBpbnRlcmNlcHRlZCBieSBjdXN0b20gd29ya2Zsb3cgcm91dGluZ1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBoYW5kbGVXb3JrZmxvd0NvbW1hbmQgfSA9IGF3YWl0IGltcG9ydChcIi4uL2NvbW1hbmRzL2hhbmRsZXJzL3dvcmtmbG93LnRzXCIpO1xuICAgIGNvbnN0IGN0eCA9IGNyZWF0ZU1vY2tDdHgoKTtcbiAgICBjb25zdCBwaSA9IGNyZWF0ZU1vY2tQaSgpO1xuICAgIC8vIFwicXVldWVcIiBkb2VzIG5vdCBzdGFydCB3aXRoIFwid29ya2Zsb3dcIiBzbyB0aGUgY3VzdG9tIHJvdXRpbmcgc2hvdWxkIG5vdCBoYW5kbGUgaXQuXG4gICAgLy8gVGhlIGZ1bmN0aW9uIG1heSBzdGlsbCBoYW5kbGUgaXQgdmlhIGl0cyBleGlzdGluZyBkZXYtd29ya2Zsb3cgcm91dGluZywgYnV0IGl0XG4gICAgLy8gc2hvdWxkIG5vdCBiZSBjYXB0dXJlZCBieSB0aGUgY3VzdG9tIHdvcmtmbG93IGBpZmAgYmxvY2suXG4gICAgLy8gV2UgdmVyaWZ5IHRoaXMgYnkgY2hlY2tpbmcgdGhhdCBhIGNsZWFybHkgbm9uLXdvcmtmbG93IGNvbW1hbmQgbGlrZSBcInNvbWV0aGluZ2Vsc2VcIlxuICAgIC8vIHJldHVybnMgZmFsc2UgKHVuaGFuZGxlZCkuXG4gICAgY29uc3QgaGFuZGxlZCA9IGF3YWl0IGhhbmRsZVdvcmtmbG93Q29tbWFuZChcInNvbWV0aGluZ2Vsc2VcIiwgY3R4IGFzIGFueSwgcGkgYXMgYW55KTtcbiAgICBhc3NlcnQuZXF1YWwoaGFuZGxlZCwgZmFsc2UsIFwibm9uLXdvcmtmbG93IGNvbW1hbmRzIHNob3VsZCByZXR1cm4gZmFsc2VcIik7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFPQSxTQUFTLFVBQVUsSUFBSSxXQUFXLGNBQWM7QUFDaEQsT0FBTyxZQUFZO0FBQ25CO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BRUs7QUFDUCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBRXZCLFNBQVMsMkJBQTJCLDZCQUE2QjtBQUlqRSxNQUFNLFVBQW9CLENBQUM7QUFDM0IsSUFBSTtBQUVKLFNBQVMsY0FBc0I7QUFDN0IsUUFBTSxNQUFNLFlBQVksS0FBSyxPQUFPLEdBQUcsY0FBYyxDQUFDO0FBQ3RELFVBQVEsS0FBSyxHQUFHO0FBQ2hCLFNBQU87QUFDVDtBQUVBLFVBQVUsTUFBTTtBQUVkLE1BQUksWUFBWSxRQUFRLElBQUksTUFBTSxVQUFVO0FBQzFDLFlBQVEsTUFBTSxRQUFRO0FBQUEsRUFDeEI7QUFDQSxhQUFXLEtBQUssU0FBUztBQUN2QixRQUFJO0FBQUUsYUFBTyxHQUFHLEVBQUUsV0FBVyxNQUFNLE9BQU8sTUFBTSxZQUFZLEdBQUcsWUFBWSxJQUFJLENBQUM7QUFBQSxJQUFHLFFBQVE7QUFBQSxJQUFzQjtBQUFBLEVBQ25IO0FBQ0EsVUFBUSxTQUFTO0FBQ25CLENBQUM7QUFFRCxPQUFPLE1BQU07QUFDWCxhQUFXLFFBQVEsSUFBSTtBQUN6QixDQUFDO0FBRUQsU0FBUyxnQkFBZ0I7QUFDdkIsUUFBTSxnQkFBc0QsQ0FBQztBQUM3RCxTQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0EsSUFBSTtBQUFBLE1BQ0YsT0FBTyxTQUFpQixPQUFlO0FBQ3JDLHNCQUFjLEtBQUssRUFBRSxTQUFTLE1BQU0sQ0FBQztBQUFBLE1BQ3ZDO0FBQUEsTUFDQSxRQUFRLFlBQVk7QUFBQSxNQUFDO0FBQUEsSUFDdkI7QUFBQSxJQUNBLFVBQVUsWUFBWTtBQUFBLElBQUM7QUFBQSxJQUN2QixnQkFBZ0I7QUFBQSxNQUNkLGdCQUFnQixNQUFNO0FBQUEsSUFDeEI7QUFBQSxFQUNGO0FBQ0Y7QUFFQSxTQUFTLGVBQWU7QUFDdEIsU0FBTztBQUFBLElBQ0wsa0JBQWtCO0FBQUEsSUFBQztBQUFBLElBQ25CLGVBQWU7QUFBQSxJQUFDO0FBQUEsSUFDaEIsbUJBQW1CO0FBQUEsSUFBQztBQUFBLElBQ3BCLEtBQUs7QUFBQSxJQUFDO0FBQUEsSUFDTixjQUFjO0FBQUEsSUFBQztBQUFBLEVBQ2pCO0FBQ0Y7QUFHQSxTQUFTLGdCQUFnQixVQUFrQixNQUFjLFNBQXVCO0FBQzlFLFFBQU0sVUFBVSxLQUFLLFVBQVUsUUFBUSxlQUFlO0FBQ3RELFlBQVUsU0FBUyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3RDLGdCQUFjLEtBQUssU0FBUyxHQUFHLElBQUksT0FBTyxHQUFHLFNBQVMsT0FBTztBQUMvRDtBQUVBLE1BQU0sYUFBYTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBWW5CLE1BQU0sY0FBYztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBUXBCLFNBQVMsaUNBQWlDLE1BQU07QUFDOUMsS0FBRywwQ0FBMEMsTUFBTTtBQUNqRCxVQUFNLFFBQVEsc0JBQXNCLEtBQUssQ0FBQyxNQUFNLEVBQUUsUUFBUSxPQUFPO0FBQ2pFLFdBQU8sR0FBRyxPQUFPLDBDQUEwQztBQUMzRCxXQUFPLE1BQU0sTUFBTyxNQUFNLGdCQUFnQjtBQUFBLEVBQzVDLENBQUM7QUFFRCxLQUFHLGlEQUFpRCxNQUFNO0FBQ3hELFVBQU0sY0FBYywwQkFBMEIsR0FBRztBQUNqRCxVQUFNLFNBQVMsWUFBWSxJQUFJLENBQUMsTUFBVyxFQUFFLEtBQUs7QUFDbEQsV0FBTyxHQUFHLE9BQU8sU0FBUyxPQUFPLEdBQUcsaUNBQWlDO0FBQUEsRUFDdkUsQ0FBQztBQUVELEtBQUcsNkNBQTZDLE1BQU07QUFDcEQsVUFBTSxRQUFRLHNCQUFzQixLQUFLLENBQUMsTUFBTSxFQUFFLFFBQVEsVUFBVTtBQUNwRSxXQUFPLEdBQUcsT0FBTyw2Q0FBNkM7QUFDOUQsV0FBTyxHQUFHLE1BQU8sS0FBSyxTQUFTLEtBQUssR0FBRyxnQ0FBZ0M7QUFDdkUsV0FBTyxHQUFHLE1BQU8sS0FBSyxTQUFTLEtBQUssR0FBRyxnQ0FBZ0M7QUFBQSxFQUN6RSxDQUFDO0FBRUQsS0FBRywwRUFBMEUsTUFBTTtBQUNqRixVQUFNLGNBQWMsMEJBQTBCLFdBQVc7QUFDekQsVUFBTSxTQUFTLFlBQVksSUFBSSxDQUFDLE1BQVcsRUFBRSxLQUFLO0FBQ2xELGVBQVcsT0FBTztBQUFBLE1BQ2hCO0FBQUEsTUFBTztBQUFBLE1BQU87QUFBQSxNQUFRO0FBQUEsTUFBUTtBQUFBLE1BQVc7QUFBQSxNQUFhO0FBQUEsTUFBWTtBQUFBLE1BQVM7QUFBQSxJQUM3RSxHQUFHO0FBQ0QsYUFBTyxHQUFHLE9BQU8sU0FBUyxHQUFHLEdBQUcsdUJBQXVCLEdBQUcsRUFBRTtBQUFBLElBQzlEO0FBQ0EsV0FBTyxNQUFNLE9BQU8sUUFBUSxHQUFHLG1DQUFtQztBQUFBLEVBQ3BFLENBQUM7QUFFRCxLQUFHLHFFQUFxRSxNQUFNO0FBQzVFLFVBQU0sY0FBYywwQkFBMEIsWUFBWTtBQUMxRCxVQUFNLFNBQVMsWUFBWSxJQUFJLENBQUMsTUFBVyxFQUFFLEtBQUs7QUFDbEQsV0FBTyxHQUFHLE9BQU8sU0FBUyxLQUFLLEdBQUcsb0JBQW9CO0FBQ3RELFdBQU8sR0FBRyxPQUFPLFNBQVMsUUFBUSxHQUFHLHVCQUF1QjtBQUM1RCxXQUFPLEdBQUcsQ0FBQyxPQUFPLFNBQVMsTUFBTSxHQUFHLHlCQUF5QjtBQUFBLEVBQy9ELENBQUM7QUFFRCxLQUFHLHVFQUF1RSxNQUFNO0FBQzlFLFVBQU0sT0FBTyxZQUFZO0FBQ3pCLG9CQUFnQixNQUFNLG1CQUFtQixVQUFVO0FBQ25ELG9CQUFnQixNQUFNLGNBQWMsVUFBVTtBQUc5QyxZQUFRLE1BQU0sSUFBSTtBQUVsQixVQUFNLGNBQWMsMEJBQTBCLGVBQWU7QUFDN0QsVUFBTSxTQUFTLFlBQVksSUFBSSxDQUFDLE1BQVcsRUFBRSxLQUFLO0FBQ2xELFdBQU8sR0FBRyxPQUFPLFNBQVMsaUJBQWlCLEdBQUcsZ0NBQWdDO0FBQzlFLFdBQU8sR0FBRyxPQUFPLFNBQVMsWUFBWSxHQUFHLDJCQUEyQjtBQUFBLEVBQ3RFLENBQUM7QUFFRCxLQUFHLDRFQUE0RSxNQUFNO0FBQ25GLFVBQU0sT0FBTyxZQUFZO0FBQ3pCLG9CQUFnQixNQUFNLGVBQWUsVUFBVTtBQUUvQyxZQUFRLE1BQU0sSUFBSTtBQUVsQixVQUFNLGNBQWMsMEJBQTBCLG9CQUFvQjtBQUNsRSxVQUFNLFNBQVMsWUFBWSxJQUFJLENBQUMsTUFBVyxFQUFFLEtBQUs7QUFDbEQsV0FBTyxHQUFHLE9BQU8sU0FBUyxhQUFhLEdBQUcsNEJBQTRCO0FBQUEsRUFDeEUsQ0FBQztBQUVELEtBQUcsaUVBQWlFLE1BQU07QUFDeEUsVUFBTSxPQUFPLFlBQVk7QUFDekIsb0JBQWdCLE1BQU0sbUJBQW1CLFVBQVU7QUFDbkQsb0JBQWdCLE1BQU0sY0FBYyxVQUFVO0FBRTlDLFlBQVEsTUFBTSxJQUFJO0FBRWxCLFVBQU0sY0FBYywwQkFBMEIsZ0JBQWdCO0FBQzlELFVBQU0sU0FBUyxZQUFZLElBQUksQ0FBQyxNQUFXLEVBQUUsS0FBSztBQUNsRCxXQUFPLEdBQUcsT0FBTyxTQUFTLGlCQUFpQixHQUFHLGdDQUFnQztBQUM5RSxXQUFPLEdBQUcsQ0FBQyxPQUFPLFNBQVMsWUFBWSxHQUFHLCtCQUErQjtBQUFBLEVBQzNFLENBQUM7QUFDSCxDQUFDO0FBSUQsU0FBUyw0QkFBNEIsTUFBTTtBQUt6QyxpQkFBZSxZQUFZLFNBQWlCO0FBQzFDLFVBQU0sRUFBRSxzQkFBc0IsSUFBSSxNQUFNLE9BQU8sa0NBQWtDO0FBQ2pGLFVBQU0sTUFBTSxjQUFjO0FBQzFCLFVBQU0sS0FBSyxhQUFhO0FBQ3hCLFVBQU0sVUFBVSxNQUFNLHNCQUFzQixTQUFTLEtBQVksRUFBUztBQUMxRSxXQUFPLEVBQUUsU0FBUyxlQUFlLElBQUksY0FBYztBQUFBLEVBQ3JEO0FBRUEsS0FBRyxzREFBc0QsWUFBWTtBQUNuRSxVQUFNLEVBQUUsU0FBUyxjQUFjLElBQUksTUFBTSxZQUFZLFVBQVU7QUFDL0QsV0FBTyxHQUFHLFNBQVMsbUJBQW1CO0FBQ3RDLFdBQU87QUFBQSxNQUNMLGNBQWMsS0FBSyxDQUFDLE1BQU0sRUFBRSxRQUFRLFNBQVMsa0JBQWtCLENBQUM7QUFBQSxNQUNoRTtBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFFRCxLQUFHLHNEQUFzRCxZQUFZO0FBQ25FLFVBQU0sRUFBRSxTQUFTLGNBQWMsSUFBSSxNQUFNLFlBQVksY0FBYztBQUNuRSxXQUFPLEdBQUcsU0FBUyxtQkFBbUI7QUFDdEMsV0FBTztBQUFBLE1BQ0wsY0FBYyxLQUFLLENBQUMsTUFBTSxFQUFFLFFBQVEsU0FBUyxpQkFBaUIsQ0FBQztBQUFBLE1BQy9EO0FBQUEsSUFDRjtBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsd0RBQXdELFlBQVk7QUFDckUsVUFBTSxFQUFFLFNBQVMsY0FBYyxJQUFJLE1BQU0sWUFBWSxjQUFjO0FBQ25FLFdBQU8sR0FBRyxTQUFTLG1CQUFtQjtBQUN0QyxXQUFPO0FBQUEsTUFDTCxjQUFjLEtBQUssQ0FBQyxNQUFNLEVBQUUsVUFBVSxhQUFhLEVBQUUsUUFBUSxTQUFTLE9BQU8sQ0FBQztBQUFBLE1BQzlFO0FBQUEsSUFDRjtBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsbURBQW1ELFlBQVk7QUFDaEUsVUFBTSxFQUFFLHFCQUFxQixJQUFJLE1BQU0sT0FBTyxrQ0FBa0M7QUFDaEYsV0FBTztBQUFBLE1BQ0wscUJBQXFCLDJEQUE2RDtBQUFBLE1BQ2xGO0FBQUEsUUFDRSxTQUFTO0FBQUEsUUFDVCxXQUFXO0FBQUEsVUFDVCxRQUFRO0FBQUEsVUFDUixRQUFRO0FBQUEsUUFDVjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyxzRUFBc0UsWUFBWTtBQUNuRixVQUFNLEVBQUUsU0FBUyxjQUFjLElBQUksTUFBTSxZQUFZLG9DQUFvQztBQUN6RixXQUFPLEdBQUcsU0FBUyxtQkFBbUI7QUFDdEMsV0FBTztBQUFBLE1BQ0wsY0FBYyxLQUFLLENBQUMsTUFBTSxFQUFFLFVBQVUsV0FBVyxFQUFFLFFBQVEsU0FBUyxXQUFXLENBQUM7QUFBQSxNQUNoRjtBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFFRCxLQUFHLDZEQUE2RCxZQUFZO0FBQzFFLFVBQU0sRUFBRSxTQUFTLGNBQWMsSUFBSSxNQUFNLFlBQVksbUJBQW1CO0FBQ3hFLFdBQU8sR0FBRyxTQUFTLG1CQUFtQjtBQUN0QyxXQUFPO0FBQUEsTUFDTCxjQUFjLEtBQUssQ0FBQyxNQUFNLEVBQUUsVUFBVSxhQUFhLEVBQUUsUUFBUSxTQUFTLE9BQU8sQ0FBQztBQUFBLE1BQzlFO0FBQUEsSUFDRjtBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsbUVBQW1FLFlBQVk7QUFDaEYsVUFBTSxFQUFFLFNBQVMsY0FBYyxJQUFJLE1BQU0sWUFBWSx5Q0FBeUM7QUFDOUYsV0FBTyxHQUFHLFNBQVMsbUJBQW1CO0FBQ3RDLFdBQU87QUFBQSxNQUNMLGNBQWMsS0FBSyxDQUFDLE1BQU0sRUFBRSxVQUFVLFdBQVcsRUFBRSxRQUFRLFNBQVMsV0FBVyxDQUFDO0FBQUEsTUFDaEY7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyw2REFBNkQsWUFBWTtBQUMxRSxVQUFNLEVBQUUsU0FBUyxjQUFjLElBQUksTUFBTSxZQUFZLGdCQUFnQjtBQUNyRSxXQUFPLEdBQUcsU0FBUyxtQkFBbUI7QUFDdEMsV0FBTztBQUFBLE1BQ0wsY0FBYyxLQUFLLENBQUMsTUFBTSxFQUFFLFVBQVUsU0FBUztBQUFBLE1BQy9DO0FBQUEsSUFDRjtBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsOERBQThELFlBQVk7QUFDM0UsVUFBTSxFQUFFLFNBQVMsY0FBYyxJQUFJLE1BQU0sWUFBWSxpQkFBaUI7QUFDdEUsV0FBTyxHQUFHLFNBQVMsbUJBQW1CO0FBQ3RDLFdBQU87QUFBQSxNQUNMLGNBQWMsS0FBSyxDQUFDLE1BQU0sRUFBRSxVQUFVLFNBQVM7QUFBQSxNQUMvQztBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFFRCxLQUFHLHdEQUF3RCxZQUFZO0FBQ3JFLFVBQU0sRUFBRSxTQUFTLGNBQWMsSUFBSSxNQUFNLFlBQVksa0JBQWtCO0FBQ3ZFLFdBQU8sR0FBRyxTQUFTLG1CQUFtQjtBQUN0QyxXQUFPO0FBQUEsTUFDTCxjQUFjLEtBQUssQ0FBQyxNQUFNLEVBQUUsUUFBUSxTQUFTLDZCQUE2QixDQUFDO0FBQUEsTUFDM0U7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyx5REFBeUQsWUFBWTtBQUN0RSxVQUFNLEVBQUUsU0FBUyxjQUFjLElBQUksTUFBTSxZQUFZLGVBQWU7QUFDcEUsV0FBTyxHQUFHLFNBQVMsbUJBQW1CO0FBQ3RDLFdBQU87QUFBQSxNQUNMLGNBQWMsS0FBSyxDQUFDLE1BQU0sRUFBRSxRQUFRLFNBQVMsd0JBQXdCLENBQUM7QUFBQSxNQUN0RTtBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFFRCxLQUFHLHdFQUF3RSxZQUFZO0FBQ3JGLFVBQU0sRUFBRSxzQkFBc0IsSUFBSSxNQUFNLE9BQU8sa0NBQWtDO0FBQ2pGLFVBQU0sTUFBTSxjQUFjO0FBQzFCLFVBQU0sS0FBSyxhQUFhO0FBTXhCLFVBQU0sVUFBVSxNQUFNLHNCQUFzQixpQkFBaUIsS0FBWSxFQUFTO0FBQ2xGLFdBQU8sTUFBTSxTQUFTLE9BQU8sMkNBQTJDO0FBQUEsRUFDMUUsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
