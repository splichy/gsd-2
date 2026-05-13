import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { diagnoseSounddeviceError, ensureVoiceVenv } from "../linux-ready.js";
describe("diagnoseSounddeviceError (#2403 branch ordering)", () => {
  test("ModuleNotFoundError with 'sounddevice' in message \u2192 missing-module", () => {
    const stderr = `Traceback (most recent call last):
  File "<string>", line 1, in <module>
ModuleNotFoundError: No module named 'sounddevice'`;
    assert.equal(diagnoseSounddeviceError(stderr), "missing-module");
  });
  test("ImportError: No module named sounddevice \u2192 missing-module", () => {
    assert.equal(
      diagnoseSounddeviceError("ImportError: No module named sounddevice"),
      "missing-module"
    );
  });
  test("PortAudio library not found \u2192 missing-portaudio", () => {
    assert.equal(
      diagnoseSounddeviceError("OSError: PortAudio library not found"),
      "missing-portaudio"
    );
  });
  test("libportaudio.so.2 cannot open \u2192 missing-portaudio (lowercase variant)", () => {
    assert.equal(
      diagnoseSounddeviceError(
        "OSError: libportaudio.so.2: cannot open shared object file: No such file or directory"
      ),
      "missing-portaudio"
    );
  });
  test("unrelated SyntaxError \u2192 unknown", () => {
    assert.equal(
      diagnoseSounddeviceError("SyntaxError: invalid syntax"),
      "unknown"
    );
  });
  test("empty stderr \u2192 unknown", () => {
    assert.equal(diagnoseSounddeviceError(""), "unknown");
  });
});
describe("ensureVoiceVenv", () => {
  test("returns true without notifying when venv already exists", () => {
    const notifications = [];
    const result = ensureVoiceVenv({
      notify: (msg) => notifications.push(msg),
      exists: () => true,
      execFile: (() => Buffer.from(""))
    });
    assert.equal(result, true);
    assert.equal(
      notifications.length,
      0,
      "should not notify when venv already exists"
    );
  });
  test("creates venv and installs sounddevice+requests when venv missing", () => {
    const notifications = [];
    const commands = [];
    let existsCalled = false;
    const result = ensureVoiceVenv({
      notify: (msg) => notifications.push(msg),
      exists: () => {
        existsCalled = true;
        return false;
      },
      execFile: ((cmd, args) => {
        commands.push([cmd, ...args]);
        return Buffer.from("");
      })
    });
    assert.equal(result, true);
    assert.ok(existsCalled, "should check if venv exists first");
    assert.equal(commands.length, 2, "should run 2 commands (venv + pip)");
    assert.equal(commands[0][0], "python3", "first command is python3");
    assert.ok(
      commands[0].includes("-m") && commands[0].includes("venv"),
      "first command creates the venv"
    );
    assert.ok(
      commands[1][0].endsWith("bin/pip"),
      "second command is pip from the new venv"
    );
    assert.ok(commands[1].includes("sounddevice"), "pip installs sounddevice");
    assert.ok(commands[1].includes("requests"), "pip installs requests");
    assert.ok(
      notifications[0].includes("one-time setup"),
      "notifies user this is one-time setup"
    );
  });
  test("returns false and emits an error notification when venv creation fails", () => {
    const notifications = [];
    const result = ensureVoiceVenv({
      notify: (msg, level) => notifications.push({ msg, level }),
      exists: () => false,
      execFile: (() => {
        throw new Error("externally-managed-environment");
      })
    });
    assert.equal(result, false);
    const errorNotif = notifications.find((n) => n.level === "error");
    assert.ok(errorNotif, "must emit an error notification on failure");
    assert.ok(
      errorNotif.msg.includes("python3 -m venv"),
      "error notification suggests manual venv creation"
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3ZvaWNlL3Rlc3RzL2xpbnV4LXJlYWR5LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogbGludXgtcmVhZHkudGVzdC50cyBcdTIwMTQgVGVzdHMgZm9yIExpbnV4IHZvaWNlIHJlYWRpbmVzcyBsb2dpYyAoIzI0MDMpLlxuICpcbiAqIENvdmVyczpcbiAqICAgLSBkaWFnbm9zZVNvdW5kZGV2aWNlRXJyb3IgYnJhbmNoIG9yZGVyaW5nIChNb2R1bGVOb3RGb3VuZEVycm9yIG11c3QgTk9UXG4gKiAgICAgbWF0Y2ggdGhlIHBvcnRhdWRpbyBicmFuY2gsIGV2ZW4gdGhvdWdoIGl0IGNvbnRhaW5zIFwic291bmRkZXZpY2VcIilcbiAqICAgLSBlbnN1cmVWb2ljZVZlbnYgYXV0by1jcmVhdGlvblxuICpcbiAqIFByZXZpb3VzIHZlcnNpb24gdXNlZCBgY3JlYXRlVGVzdENvbnRleHQoKWAgKyBhIHRvcC1sZXZlbCBgbWFpbigpYCBjYWxsIFx1MjAxNFxuICogdGhvc2UgZG9uJ3QgcmVnaXN0ZXIgd2l0aCBgbm9kZSAtLXRlc3RgLCBzbyB0aGUgZmlsZSByYW4gYXQgaW1wb3J0IHRpbWVcbiAqIGJ1dCB0aGUgdGVzdCBydW5uZXIgc2F3IHplcm8gdGVzdHMuIENJIHJlcG9ydGVyIHNob3dlZCBubyBvdXRwdXQgZm9yXG4gKiB0aGlzIGZpbGUuIFJld3JpdGUgdXNlcyBgbm9kZTp0ZXN0YCBzbyByZXN1bHRzIGFyZSBjb2xsZWN0ZWQgcHJvcGVybHkuXG4gKiBTZWUgIzQ4MDkgLyAjNDc4NC5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuXG5pbXBvcnQgeyBkaWFnbm9zZVNvdW5kZGV2aWNlRXJyb3IsIGVuc3VyZVZvaWNlVmVudiB9IGZyb20gXCIuLi9saW51eC1yZWFkeS50c1wiO1xuXG5kZXNjcmliZShcImRpYWdub3NlU291bmRkZXZpY2VFcnJvciAoIzI0MDMgYnJhbmNoIG9yZGVyaW5nKVwiLCAoKSA9PiB7XG4gIHRlc3QoXCJNb2R1bGVOb3RGb3VuZEVycm9yIHdpdGggJ3NvdW5kZGV2aWNlJyBpbiBtZXNzYWdlIFx1MjE5MiBtaXNzaW5nLW1vZHVsZVwiLCAoKSA9PiB7XG4gICAgLy8gVGhlIGNyaXRpY2FsIHJlZ3Jlc3Npb246IHRoZSBzdGRlcnIgc3RyaW5nIGNvbnRhaW5zIFwic291bmRkZXZpY2VcIixcbiAgICAvLyBzbyBhIG5haXZlIGJyYW5jaC1vcmRlciBjaGVjayB3b3VsZCBtYXRjaCB0aGUgcG9ydGF1ZGlvIGJyYW5jaFxuICAgIC8vIGZpcnN0LiBDb3JyZWN0IGNsYXNzaWZpY2F0aW9uIGlzIG1pc3NpbmctbW9kdWxlLlxuICAgIGNvbnN0IHN0ZGVyciA9XG4gICAgICBcIlRyYWNlYmFjayAobW9zdCByZWNlbnQgY2FsbCBsYXN0KTpcXG5cIiArXG4gICAgICAnICBGaWxlIFwiPHN0cmluZz5cIiwgbGluZSAxLCBpbiA8bW9kdWxlPlxcbicgK1xuICAgICAgXCJNb2R1bGVOb3RGb3VuZEVycm9yOiBObyBtb2R1bGUgbmFtZWQgJ3NvdW5kZGV2aWNlJ1wiO1xuICAgIGFzc2VydC5lcXVhbChkaWFnbm9zZVNvdW5kZGV2aWNlRXJyb3Ioc3RkZXJyKSwgXCJtaXNzaW5nLW1vZHVsZVwiKTtcbiAgfSk7XG5cbiAgdGVzdChcIkltcG9ydEVycm9yOiBObyBtb2R1bGUgbmFtZWQgc291bmRkZXZpY2UgXHUyMTkyIG1pc3NpbmctbW9kdWxlXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBkaWFnbm9zZVNvdW5kZGV2aWNlRXJyb3IoXCJJbXBvcnRFcnJvcjogTm8gbW9kdWxlIG5hbWVkIHNvdW5kZGV2aWNlXCIpLFxuICAgICAgXCJtaXNzaW5nLW1vZHVsZVwiLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJQb3J0QXVkaW8gbGlicmFyeSBub3QgZm91bmQgXHUyMTkyIG1pc3NpbmctcG9ydGF1ZGlvXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBkaWFnbm9zZVNvdW5kZGV2aWNlRXJyb3IoXCJPU0Vycm9yOiBQb3J0QXVkaW8gbGlicmFyeSBub3QgZm91bmRcIiksXG4gICAgICBcIm1pc3NpbmctcG9ydGF1ZGlvXCIsXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcImxpYnBvcnRhdWRpby5zby4yIGNhbm5vdCBvcGVuIFx1MjE5MiBtaXNzaW5nLXBvcnRhdWRpbyAobG93ZXJjYXNlIHZhcmlhbnQpXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBkaWFnbm9zZVNvdW5kZGV2aWNlRXJyb3IoXG4gICAgICAgIFwiT1NFcnJvcjogbGlicG9ydGF1ZGlvLnNvLjI6IGNhbm5vdCBvcGVuIHNoYXJlZCBvYmplY3QgZmlsZTogTm8gc3VjaCBmaWxlIG9yIGRpcmVjdG9yeVwiLFxuICAgICAgKSxcbiAgICAgIFwibWlzc2luZy1wb3J0YXVkaW9cIixcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwidW5yZWxhdGVkIFN5bnRheEVycm9yIFx1MjE5MiB1bmtub3duXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBkaWFnbm9zZVNvdW5kZGV2aWNlRXJyb3IoXCJTeW50YXhFcnJvcjogaW52YWxpZCBzeW50YXhcIiksXG4gICAgICBcInVua25vd25cIixcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwiZW1wdHkgc3RkZXJyIFx1MjE5MiB1bmtub3duXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoZGlhZ25vc2VTb3VuZGRldmljZUVycm9yKFwiXCIpLCBcInVua25vd25cIik7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiZW5zdXJlVm9pY2VWZW52XCIsICgpID0+IHtcbiAgdGVzdChcInJldHVybnMgdHJ1ZSB3aXRob3V0IG5vdGlmeWluZyB3aGVuIHZlbnYgYWxyZWFkeSBleGlzdHNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG5vdGlmaWNhdGlvbnM6IHN0cmluZ1tdID0gW107XG4gICAgY29uc3QgcmVzdWx0ID0gZW5zdXJlVm9pY2VWZW52KHtcbiAgICAgIG5vdGlmeTogKG1zZykgPT4gbm90aWZpY2F0aW9ucy5wdXNoKG1zZyksXG4gICAgICBleGlzdHM6ICgpID0+IHRydWUsXG4gICAgICBleGVjRmlsZTogKCgpID0+IEJ1ZmZlci5mcm9tKFwiXCIpKSBhcyBuZXZlcixcbiAgICB9KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBub3RpZmljYXRpb25zLmxlbmd0aCxcbiAgICAgIDAsXG4gICAgICBcInNob3VsZCBub3Qgbm90aWZ5IHdoZW4gdmVudiBhbHJlYWR5IGV4aXN0c1wiLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJjcmVhdGVzIHZlbnYgYW5kIGluc3RhbGxzIHNvdW5kZGV2aWNlK3JlcXVlc3RzIHdoZW4gdmVudiBtaXNzaW5nXCIsICgpID0+IHtcbiAgICBjb25zdCBub3RpZmljYXRpb25zOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IGNvbW1hbmRzOiBzdHJpbmdbXVtdID0gW107XG4gICAgbGV0IGV4aXN0c0NhbGxlZCA9IGZhbHNlO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gZW5zdXJlVm9pY2VWZW52KHtcbiAgICAgIG5vdGlmeTogKG1zZykgPT4gbm90aWZpY2F0aW9ucy5wdXNoKG1zZyksXG4gICAgICBleGlzdHM6ICgpID0+IHtcbiAgICAgICAgZXhpc3RzQ2FsbGVkID0gdHJ1ZTtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfSxcbiAgICAgIGV4ZWNGaWxlOiAoKGNtZDogc3RyaW5nLCBhcmdzOiBzdHJpbmdbXSkgPT4ge1xuICAgICAgICBjb21tYW5kcy5wdXNoKFtjbWQsIC4uLmFyZ3NdKTtcbiAgICAgICAgcmV0dXJuIEJ1ZmZlci5mcm9tKFwiXCIpO1xuICAgICAgfSkgYXMgbmV2ZXIsXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCB0cnVlKTtcbiAgICBhc3NlcnQub2soZXhpc3RzQ2FsbGVkLCBcInNob3VsZCBjaGVjayBpZiB2ZW52IGV4aXN0cyBmaXJzdFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoY29tbWFuZHMubGVuZ3RoLCAyLCBcInNob3VsZCBydW4gMiBjb21tYW5kcyAodmVudiArIHBpcClcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGNvbW1hbmRzWzBdIVswXSwgXCJweXRob24zXCIsIFwiZmlyc3QgY29tbWFuZCBpcyBweXRob24zXCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIGNvbW1hbmRzWzBdIS5pbmNsdWRlcyhcIi1tXCIpICYmIGNvbW1hbmRzWzBdIS5pbmNsdWRlcyhcInZlbnZcIiksXG4gICAgICBcImZpcnN0IGNvbW1hbmQgY3JlYXRlcyB0aGUgdmVudlwiLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgY29tbWFuZHNbMV0hWzBdIS5lbmRzV2l0aChcImJpbi9waXBcIiksXG4gICAgICBcInNlY29uZCBjb21tYW5kIGlzIHBpcCBmcm9tIHRoZSBuZXcgdmVudlwiLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKGNvbW1hbmRzWzFdIS5pbmNsdWRlcyhcInNvdW5kZGV2aWNlXCIpLCBcInBpcCBpbnN0YWxscyBzb3VuZGRldmljZVwiKTtcbiAgICBhc3NlcnQub2soY29tbWFuZHNbMV0hLmluY2x1ZGVzKFwicmVxdWVzdHNcIiksIFwicGlwIGluc3RhbGxzIHJlcXVlc3RzXCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIG5vdGlmaWNhdGlvbnNbMF0hLmluY2x1ZGVzKFwib25lLXRpbWUgc2V0dXBcIiksXG4gICAgICBcIm5vdGlmaWVzIHVzZXIgdGhpcyBpcyBvbmUtdGltZSBzZXR1cFwiLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXR1cm5zIGZhbHNlIGFuZCBlbWl0cyBhbiBlcnJvciBub3RpZmljYXRpb24gd2hlbiB2ZW52IGNyZWF0aW9uIGZhaWxzXCIsICgpID0+IHtcbiAgICBjb25zdCBub3RpZmljYXRpb25zOiBBcnJheTx7IG1zZzogc3RyaW5nOyBsZXZlbD86IHN0cmluZyB9PiA9IFtdO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gZW5zdXJlVm9pY2VWZW52KHtcbiAgICAgIG5vdGlmeTogKG1zZywgbGV2ZWwpID0+IG5vdGlmaWNhdGlvbnMucHVzaCh7IG1zZywgbGV2ZWwgfSksXG4gICAgICBleGlzdHM6ICgpID0+IGZhbHNlLFxuICAgICAgZXhlY0ZpbGU6ICgoKSA9PiB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcImV4dGVybmFsbHktbWFuYWdlZC1lbnZpcm9ubWVudFwiKTtcbiAgICAgIH0pIGFzIG5ldmVyLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgZmFsc2UpO1xuICAgIGNvbnN0IGVycm9yTm90aWYgPSBub3RpZmljYXRpb25zLmZpbmQoKG4pID0+IG4ubGV2ZWwgPT09IFwiZXJyb3JcIik7XG4gICAgYXNzZXJ0Lm9rKGVycm9yTm90aWYsIFwibXVzdCBlbWl0IGFuIGVycm9yIG5vdGlmaWNhdGlvbiBvbiBmYWlsdXJlXCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIGVycm9yTm90aWYhLm1zZy5pbmNsdWRlcyhcInB5dGhvbjMgLW0gdmVudlwiKSxcbiAgICAgIFwiZXJyb3Igbm90aWZpY2F0aW9uIHN1Z2dlc3RzIG1hbnVhbCB2ZW52IGNyZWF0aW9uXCIsXG4gICAgKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQWVBLFNBQVMsVUFBVSxZQUFZO0FBQy9CLE9BQU8sWUFBWTtBQUVuQixTQUFTLDBCQUEwQix1QkFBdUI7QUFFMUQsU0FBUyxvREFBb0QsTUFBTTtBQUNqRSxPQUFLLDJFQUFzRSxNQUFNO0FBSS9FLFVBQU0sU0FDSjtBQUFBO0FBQUE7QUFHRixX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
