import test from "node:test";
import assert from "node:assert/strict";
import { registerGSDCommand } from "../commands.js";
import { handleGSDCommand } from "../commands/dispatcher.js";
function createMockPi() {
  const commands = /* @__PURE__ */ new Map();
  return {
    registerCommand(name, options) {
      commands.set(name, options);
    },
    registerTool() {
    },
    registerShortcut() {
    },
    on() {
    },
    sendMessage() {
    },
    commands
  };
}
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
    }
  };
}
test("/gsd description includes discuss", () => {
  const pi = createMockPi();
  registerGSDCommand(pi);
  const gsd = pi.commands.get("gsd");
  assert.ok(gsd, "registerGSDCommand should register /gsd");
  assert.ok(
    gsd.description.includes("discuss"),
    "description should include discuss"
  );
});
test("/gsd description includes debug", () => {
  const pi = createMockPi();
  registerGSDCommand(pi);
  const gsd = pi.commands.get("gsd");
  assert.ok(gsd.description.includes("debug"), "description should include debug");
});
test("/gsd next completions include --debug", () => {
  const pi = createMockPi();
  registerGSDCommand(pi);
  const gsd = pi.commands.get("gsd");
  const completions = gsd.getArgumentCompletions("next ");
  const debug = completions.find((c) => c.value === "next --debug");
  assert.ok(debug, "next --debug should appear in completions");
});
test("/gsd debug completions include list|status|continue|--diagnose", () => {
  const pi = createMockPi();
  registerGSDCommand(pi);
  const gsd = pi.commands.get("gsd");
  const completions = gsd.getArgumentCompletions("debug ");
  const values = completions.map((c) => c.value);
  for (const expected of ["debug list", "debug status", "debug continue", "debug --diagnose"]) {
    assert.ok(values.includes(expected), `missing completion: ${expected}`);
  }
});
test("/gsd widget completions include full|small|min|off", () => {
  const pi = createMockPi();
  registerGSDCommand(pi);
  const gsd = pi.commands.get("gsd");
  const completions = gsd.getArgumentCompletions("widget ");
  const values = completions.map((c) => c.value);
  for (const expected of ["widget full", "widget small", "widget min", "widget off"]) {
    assert.ok(values.includes(expected), `missing completion: ${expected}`);
  }
});
test("/gsd logs completions still include debug after adding /gsd debug", () => {
  const pi = createMockPi();
  registerGSDCommand(pi);
  const gsd = pi.commands.get("gsd");
  const completions = gsd.getArgumentCompletions("logs ");
  const values = completions.map((c) => c.value);
  assert.ok(values.includes("logs debug"), "logs debug completion should remain available");
});
test("/gsd help full includes /gsd debug command", async () => {
  const ctx = createMockCtx();
  await handleGSDCommand("help full", ctx, {});
  const helpText = ctx.notifications.map((n) => n.message).join("\n");
  assert.match(helpText, /\/gsd debug\s+Create\/list\/continue persistent debug sessions/);
});
test("bare /gsd skip shows usage and does not fall through to unknown-command warning", async () => {
  const ctx = createMockCtx();
  await handleGSDCommand("skip", ctx, {});
  assert.ok(
    ctx.notifications.some((n) => n.message.includes("Usage: /gsd skip <unit-id>")),
    "should show skip usage guidance"
  );
  assert.ok(
    !ctx.notifications.some((n) => n.message.startsWith("Unknown: /gsd skip")),
    "should not emit unknown-command warning for bare skip"
  );
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hdXRvY29tcGxldGUtcmVncmVzc2lvbnMtMTY3NS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcblxuaW1wb3J0IHsgcmVnaXN0ZXJHU0RDb21tYW5kIH0gZnJvbSBcIi4uL2NvbW1hbmRzLnRzXCI7XG5pbXBvcnQgeyBoYW5kbGVHU0RDb21tYW5kIH0gZnJvbSBcIi4uL2NvbW1hbmRzL2Rpc3BhdGNoZXIudHNcIjtcblxuZnVuY3Rpb24gY3JlYXRlTW9ja1BpKCkge1xuICBjb25zdCBjb21tYW5kcyA9IG5ldyBNYXA8c3RyaW5nLCBhbnk+KCk7XG4gIHJldHVybiB7XG4gICAgcmVnaXN0ZXJDb21tYW5kKG5hbWU6IHN0cmluZywgb3B0aW9uczogYW55KSB7XG4gICAgICBjb21tYW5kcy5zZXQobmFtZSwgb3B0aW9ucyk7XG4gICAgfSxcbiAgICByZWdpc3RlclRvb2woKSB7fSxcbiAgICByZWdpc3RlclNob3J0Y3V0KCkge30sXG4gICAgb24oKSB7fSxcbiAgICBzZW5kTWVzc2FnZSgpIHt9LFxuICAgIGNvbW1hbmRzLFxuICB9O1xufVxuXG5mdW5jdGlvbiBjcmVhdGVNb2NrQ3R4KCkge1xuICBjb25zdCBub3RpZmljYXRpb25zOiB7IG1lc3NhZ2U6IHN0cmluZzsgbGV2ZWw6IHN0cmluZyB9W10gPSBbXTtcbiAgcmV0dXJuIHtcbiAgICBub3RpZmljYXRpb25zLFxuICAgIHVpOiB7XG4gICAgICBub3RpZnkobWVzc2FnZTogc3RyaW5nLCBsZXZlbDogc3RyaW5nKSB7XG4gICAgICAgIG5vdGlmaWNhdGlvbnMucHVzaCh7IG1lc3NhZ2UsIGxldmVsIH0pO1xuICAgICAgfSxcbiAgICAgIGN1c3RvbTogYXN5bmMgKCkgPT4ge30sXG4gICAgfSxcbiAgICBzaHV0ZG93bjogYXN5bmMgKCkgPT4ge30sXG4gIH07XG59XG5cbnRlc3QoXCIvZ3NkIGRlc2NyaXB0aW9uIGluY2x1ZGVzIGRpc2N1c3NcIiwgKCkgPT4ge1xuICBjb25zdCBwaSA9IGNyZWF0ZU1vY2tQaSgpO1xuICByZWdpc3RlckdTRENvbW1hbmQocGkgYXMgYW55KTtcblxuICBjb25zdCBnc2QgPSBwaS5jb21tYW5kcy5nZXQoXCJnc2RcIik7XG4gIGFzc2VydC5vayhnc2QsIFwicmVnaXN0ZXJHU0RDb21tYW5kIHNob3VsZCByZWdpc3RlciAvZ3NkXCIpO1xuICBhc3NlcnQub2soXG4gICAgZ3NkLmRlc2NyaXB0aW9uLmluY2x1ZGVzKFwiZGlzY3Vzc1wiKSxcbiAgICBcImRlc2NyaXB0aW9uIHNob3VsZCBpbmNsdWRlIGRpc2N1c3NcIixcbiAgKTtcbn0pO1xuXG50ZXN0KFwiL2dzZCBkZXNjcmlwdGlvbiBpbmNsdWRlcyBkZWJ1Z1wiLCAoKSA9PiB7XG4gIGNvbnN0IHBpID0gY3JlYXRlTW9ja1BpKCk7XG4gIHJlZ2lzdGVyR1NEQ29tbWFuZChwaSBhcyBhbnkpO1xuXG4gIGNvbnN0IGdzZCA9IHBpLmNvbW1hbmRzLmdldChcImdzZFwiKTtcbiAgYXNzZXJ0Lm9rKGdzZC5kZXNjcmlwdGlvbi5pbmNsdWRlcyhcImRlYnVnXCIpLCBcImRlc2NyaXB0aW9uIHNob3VsZCBpbmNsdWRlIGRlYnVnXCIpO1xufSk7XG5cbnRlc3QoXCIvZ3NkIG5leHQgY29tcGxldGlvbnMgaW5jbHVkZSAtLWRlYnVnXCIsICgpID0+IHtcbiAgY29uc3QgcGkgPSBjcmVhdGVNb2NrUGkoKTtcbiAgcmVnaXN0ZXJHU0RDb21tYW5kKHBpIGFzIGFueSk7XG5cbiAgY29uc3QgZ3NkID0gcGkuY29tbWFuZHMuZ2V0KFwiZ3NkXCIpO1xuICBjb25zdCBjb21wbGV0aW9ucyA9IGdzZC5nZXRBcmd1bWVudENvbXBsZXRpb25zKFwibmV4dCBcIik7XG4gIGNvbnN0IGRlYnVnID0gY29tcGxldGlvbnMuZmluZCgoYzogYW55KSA9PiBjLnZhbHVlID09PSBcIm5leHQgLS1kZWJ1Z1wiKTtcbiAgYXNzZXJ0Lm9rKGRlYnVnLCBcIm5leHQgLS1kZWJ1ZyBzaG91bGQgYXBwZWFyIGluIGNvbXBsZXRpb25zXCIpO1xufSk7XG5cbnRlc3QoXCIvZ3NkIGRlYnVnIGNvbXBsZXRpb25zIGluY2x1ZGUgbGlzdHxzdGF0dXN8Y29udGludWV8LS1kaWFnbm9zZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHBpID0gY3JlYXRlTW9ja1BpKCk7XG4gIHJlZ2lzdGVyR1NEQ29tbWFuZChwaSBhcyBhbnkpO1xuXG4gIGNvbnN0IGdzZCA9IHBpLmNvbW1hbmRzLmdldChcImdzZFwiKTtcbiAgY29uc3QgY29tcGxldGlvbnMgPSBnc2QuZ2V0QXJndW1lbnRDb21wbGV0aW9ucyhcImRlYnVnIFwiKTtcbiAgY29uc3QgdmFsdWVzID0gY29tcGxldGlvbnMubWFwKChjOiBhbnkpID0+IGMudmFsdWUpO1xuICBmb3IgKGNvbnN0IGV4cGVjdGVkIG9mIFtcImRlYnVnIGxpc3RcIiwgXCJkZWJ1ZyBzdGF0dXNcIiwgXCJkZWJ1ZyBjb250aW51ZVwiLCBcImRlYnVnIC0tZGlhZ25vc2VcIl0pIHtcbiAgICBhc3NlcnQub2sodmFsdWVzLmluY2x1ZGVzKGV4cGVjdGVkKSwgYG1pc3NpbmcgY29tcGxldGlvbjogJHtleHBlY3RlZH1gKTtcbiAgfVxufSk7XG5cbnRlc3QoXCIvZ3NkIHdpZGdldCBjb21wbGV0aW9ucyBpbmNsdWRlIGZ1bGx8c21hbGx8bWlufG9mZlwiLCAoKSA9PiB7XG4gIGNvbnN0IHBpID0gY3JlYXRlTW9ja1BpKCk7XG4gIHJlZ2lzdGVyR1NEQ29tbWFuZChwaSBhcyBhbnkpO1xuXG4gIGNvbnN0IGdzZCA9IHBpLmNvbW1hbmRzLmdldChcImdzZFwiKTtcbiAgY29uc3QgY29tcGxldGlvbnMgPSBnc2QuZ2V0QXJndW1lbnRDb21wbGV0aW9ucyhcIndpZGdldCBcIik7XG4gIGNvbnN0IHZhbHVlcyA9IGNvbXBsZXRpb25zLm1hcCgoYzogYW55KSA9PiBjLnZhbHVlKTtcbiAgZm9yIChjb25zdCBleHBlY3RlZCBvZiBbXCJ3aWRnZXQgZnVsbFwiLCBcIndpZGdldCBzbWFsbFwiLCBcIndpZGdldCBtaW5cIiwgXCJ3aWRnZXQgb2ZmXCJdKSB7XG4gICAgYXNzZXJ0Lm9rKHZhbHVlcy5pbmNsdWRlcyhleHBlY3RlZCksIGBtaXNzaW5nIGNvbXBsZXRpb246ICR7ZXhwZWN0ZWR9YCk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiL2dzZCBsb2dzIGNvbXBsZXRpb25zIHN0aWxsIGluY2x1ZGUgZGVidWcgYWZ0ZXIgYWRkaW5nIC9nc2QgZGVidWdcIiwgKCkgPT4ge1xuICBjb25zdCBwaSA9IGNyZWF0ZU1vY2tQaSgpO1xuICByZWdpc3RlckdTRENvbW1hbmQocGkgYXMgYW55KTtcblxuICBjb25zdCBnc2QgPSBwaS5jb21tYW5kcy5nZXQoXCJnc2RcIik7XG4gIGNvbnN0IGNvbXBsZXRpb25zID0gZ3NkLmdldEFyZ3VtZW50Q29tcGxldGlvbnMoXCJsb2dzIFwiKTtcbiAgY29uc3QgdmFsdWVzID0gY29tcGxldGlvbnMubWFwKChjOiBhbnkpID0+IGMudmFsdWUpO1xuICBhc3NlcnQub2sodmFsdWVzLmluY2x1ZGVzKFwibG9ncyBkZWJ1Z1wiKSwgXCJsb2dzIGRlYnVnIGNvbXBsZXRpb24gc2hvdWxkIHJlbWFpbiBhdmFpbGFibGVcIik7XG59KTtcblxudGVzdChcIi9nc2QgaGVscCBmdWxsIGluY2x1ZGVzIC9nc2QgZGVidWcgY29tbWFuZFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGN0eCA9IGNyZWF0ZU1vY2tDdHgoKTtcblxuICBhd2FpdCBoYW5kbGVHU0RDb21tYW5kKFwiaGVscCBmdWxsXCIsIGN0eCBhcyBhbnksIHt9IGFzIGFueSk7XG5cbiAgY29uc3QgaGVscFRleHQgPSBjdHgubm90aWZpY2F0aW9ucy5tYXAoKG4pID0+IG4ubWVzc2FnZSkuam9pbihcIlxcblwiKTtcbiAgYXNzZXJ0Lm1hdGNoKGhlbHBUZXh0LCAvXFwvZ3NkIGRlYnVnXFxzK0NyZWF0ZVxcL2xpc3RcXC9jb250aW51ZSBwZXJzaXN0ZW50IGRlYnVnIHNlc3Npb25zLyk7XG59KTtcblxudGVzdChcImJhcmUgL2dzZCBza2lwIHNob3dzIHVzYWdlIGFuZCBkb2VzIG5vdCBmYWxsIHRocm91Z2ggdG8gdW5rbm93bi1jb21tYW5kIHdhcm5pbmdcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBjdHggPSBjcmVhdGVNb2NrQ3R4KCk7XG5cbiAgYXdhaXQgaGFuZGxlR1NEQ29tbWFuZChcInNraXBcIiwgY3R4IGFzIGFueSwge30gYXMgYW55KTtcblxuICBhc3NlcnQub2soXG4gICAgY3R4Lm5vdGlmaWNhdGlvbnMuc29tZSgobikgPT4gbi5tZXNzYWdlLmluY2x1ZGVzKFwiVXNhZ2U6IC9nc2Qgc2tpcCA8dW5pdC1pZD5cIikpLFxuICAgIFwic2hvdWxkIHNob3cgc2tpcCB1c2FnZSBndWlkYW5jZVwiLFxuICApO1xuICBhc3NlcnQub2soXG4gICAgIWN0eC5ub3RpZmljYXRpb25zLnNvbWUoKG4pID0+IG4ubWVzc2FnZS5zdGFydHNXaXRoKFwiVW5rbm93bjogL2dzZCBza2lwXCIpKSxcbiAgICBcInNob3VsZCBub3QgZW1pdCB1bmtub3duLWNvbW1hbmQgd2FybmluZyBmb3IgYmFyZSBza2lwXCIsXG4gICk7XG59KTtcblxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUVuQixTQUFTLDBCQUEwQjtBQUNuQyxTQUFTLHdCQUF3QjtBQUVqQyxTQUFTLGVBQWU7QUFDdEIsUUFBTSxXQUFXLG9CQUFJLElBQWlCO0FBQ3RDLFNBQU87QUFBQSxJQUNMLGdCQUFnQixNQUFjLFNBQWM7QUFDMUMsZUFBUyxJQUFJLE1BQU0sT0FBTztBQUFBLElBQzVCO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFBQztBQUFBLElBQ2hCLG1CQUFtQjtBQUFBLElBQUM7QUFBQSxJQUNwQixLQUFLO0FBQUEsSUFB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
