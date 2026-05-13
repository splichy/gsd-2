import test from "node:test";
import assert from "node:assert/strict";
import { GSDConfigOverlay, formatConfigText } from "../config-overlay.js";
import { handleCoreCommand } from "../commands/handlers/core.js";
const theme = {
  bold: (s) => s,
  fg: (_name, s) => s
};
test("GSDConfigOverlay renders and responds to input", () => {
  let renderRequests = 0;
  let closed = false;
  const overlay = new GSDConfigOverlay(
    { requestRender: () => {
      renderRequests++;
    } },
    theme,
    () => {
      closed = true;
    }
  );
  const lines = overlay.render(60);
  assert.ok(lines.some((line) => line.includes("GSD Configuration")));
  overlay.handleInput("j");
  assert.equal(renderRequests, 1);
  overlay.handleInput("q");
  assert.equal(closed, true);
});
test("formatConfigText provides a text fallback", () => {
  const text = formatConfigText();
  assert.match(text, /GSD Configuration/);
  assert.match(text, /SOURCES/);
});
test("core handler routes show-config to overlay with text fallback", async () => {
  const notifications = [];
  const ctx = {
    ui: {
      custom: async () => void 0,
      notify: (message, level) => {
        notifications.push({ message, level });
      }
    }
  };
  const handled = await handleCoreCommand("show-config", ctx);
  assert.equal(handled, true);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.level, "info");
  assert.match(notifications[0]?.message ?? "", /GSD Configuration/);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9zaG93LWNvbmZpZy1jb21tYW5kLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogL2dzZCBzaG93LWNvbmZpZyBjb21tYW5kIGJlaGF2aW9yIHRlc3RzLlxuICovXG5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuXG5pbXBvcnQgeyBHU0RDb25maWdPdmVybGF5LCBmb3JtYXRDb25maWdUZXh0IH0gZnJvbSBcIi4uL2NvbmZpZy1vdmVybGF5LnRzXCI7XG5pbXBvcnQgeyBoYW5kbGVDb3JlQ29tbWFuZCB9IGZyb20gXCIuLi9jb21tYW5kcy9oYW5kbGVycy9jb3JlLnRzXCI7XG5cbmNvbnN0IHRoZW1lID0ge1xuICBib2xkOiAoczogc3RyaW5nKSA9PiBzLFxuICBmZzogKF9uYW1lOiBzdHJpbmcsIHM6IHN0cmluZykgPT4gcyxcbn07XG5cbnRlc3QoXCJHU0RDb25maWdPdmVybGF5IHJlbmRlcnMgYW5kIHJlc3BvbmRzIHRvIGlucHV0XCIsICgpID0+IHtcbiAgbGV0IHJlbmRlclJlcXVlc3RzID0gMDtcbiAgbGV0IGNsb3NlZCA9IGZhbHNlO1xuICBjb25zdCBvdmVybGF5ID0gbmV3IEdTRENvbmZpZ092ZXJsYXkoXG4gICAgeyByZXF1ZXN0UmVuZGVyOiAoKSA9PiB7IHJlbmRlclJlcXVlc3RzKys7IH0gfSxcbiAgICB0aGVtZSBhcyBhbnksXG4gICAgKCkgPT4geyBjbG9zZWQgPSB0cnVlOyB9LFxuICApO1xuXG4gIGNvbnN0IGxpbmVzID0gb3ZlcmxheS5yZW5kZXIoNjApO1xuICBhc3NlcnQub2sobGluZXMuc29tZSgobGluZSkgPT4gbGluZS5pbmNsdWRlcyhcIkdTRCBDb25maWd1cmF0aW9uXCIpKSk7XG5cbiAgb3ZlcmxheS5oYW5kbGVJbnB1dChcImpcIik7XG4gIGFzc2VydC5lcXVhbChyZW5kZXJSZXF1ZXN0cywgMSk7XG5cbiAgb3ZlcmxheS5oYW5kbGVJbnB1dChcInFcIik7XG4gIGFzc2VydC5lcXVhbChjbG9zZWQsIHRydWUpO1xufSk7XG5cbnRlc3QoXCJmb3JtYXRDb25maWdUZXh0IHByb3ZpZGVzIGEgdGV4dCBmYWxsYmFja1wiLCAoKSA9PiB7XG4gIGNvbnN0IHRleHQgPSBmb3JtYXRDb25maWdUZXh0KCk7XG4gIGFzc2VydC5tYXRjaCh0ZXh0LCAvR1NEIENvbmZpZ3VyYXRpb24vKTtcbiAgYXNzZXJ0Lm1hdGNoKHRleHQsIC9TT1VSQ0VTLyk7XG59KTtcblxudGVzdChcImNvcmUgaGFuZGxlciByb3V0ZXMgc2hvdy1jb25maWcgdG8gb3ZlcmxheSB3aXRoIHRleHQgZmFsbGJhY2tcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBub3RpZmljYXRpb25zOiBBcnJheTx7IG1lc3NhZ2U6IHN0cmluZzsgbGV2ZWw6IHN0cmluZyB9PiA9IFtdO1xuICBjb25zdCBjdHggPSB7XG4gICAgdWk6IHtcbiAgICAgIGN1c3RvbTogYXN5bmMgKCkgPT4gdW5kZWZpbmVkLFxuICAgICAgbm90aWZ5OiAobWVzc2FnZTogc3RyaW5nLCBsZXZlbDogc3RyaW5nKSA9PiB7XG4gICAgICAgIG5vdGlmaWNhdGlvbnMucHVzaCh7IG1lc3NhZ2UsIGxldmVsIH0pO1xuICAgICAgfSxcbiAgICB9LFxuICB9O1xuXG4gIGNvbnN0IGhhbmRsZWQgPSBhd2FpdCBoYW5kbGVDb3JlQ29tbWFuZChcInNob3ctY29uZmlnXCIsIGN0eCBhcyBhbnkpO1xuXG4gIGFzc2VydC5lcXVhbChoYW5kbGVkLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKG5vdGlmaWNhdGlvbnMubGVuZ3RoLCAxKTtcbiAgYXNzZXJ0LmVxdWFsKG5vdGlmaWNhdGlvbnNbMF0/LmxldmVsLCBcImluZm9cIik7XG4gIGFzc2VydC5tYXRjaChub3RpZmljYXRpb25zWzBdPy5tZXNzYWdlID8/IFwiXCIsIC9HU0QgQ29uZmlndXJhdGlvbi8pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFJQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBRW5CLFNBQVMsa0JBQWtCLHdCQUF3QjtBQUNuRCxTQUFTLHlCQUF5QjtBQUVsQyxNQUFNLFFBQVE7QUFBQSxFQUNaLE1BQU0sQ0FBQyxNQUFjO0FBQUEsRUFDckIsSUFBSSxDQUFDLE9BQWUsTUFBYztBQUNwQztBQUVBLEtBQUssa0RBQWtELE1BQU07QUFDM0QsTUFBSSxpQkFBaUI7QUFDckIsTUFBSSxTQUFTO0FBQ2IsUUFBTSxVQUFVLElBQUk7QUFBQSxJQUNsQixFQUFFLGVBQWUsTUFBTTtBQUFFO0FBQUEsSUFBa0IsRUFBRTtBQUFBLElBQzdDO0FBQUEsSUFDQSxNQUFNO0FBQUUsZUFBUztBQUFBLElBQU07QUFBQSxFQUN6QjtBQUVBLFFBQU0sUUFBUSxRQUFRLE9BQU8sRUFBRTtBQUMvQixTQUFPLEdBQUcsTUFBTSxLQUFLLENBQUMsU0FBUyxLQUFLLFNBQVMsbUJBQW1CLENBQUMsQ0FBQztBQUVsRSxVQUFRLFlBQVksR0FBRztBQUN2QixTQUFPLE1BQU0sZ0JBQWdCLENBQUM7QUFFOUIsVUFBUSxZQUFZLEdBQUc7QUFDdkIsU0FBTyxNQUFNLFFBQVEsSUFBSTtBQUMzQixDQUFDO0FBRUQsS0FBSyw2Q0FBNkMsTUFBTTtBQUN0RCxRQUFNLE9BQU8saUJBQWlCO0FBQzlCLFNBQU8sTUFBTSxNQUFNLG1CQUFtQjtBQUN0QyxTQUFPLE1BQU0sTUFBTSxTQUFTO0FBQzlCLENBQUM7QUFFRCxLQUFLLGlFQUFpRSxZQUFZO0FBQ2hGLFFBQU0sZ0JBQTJELENBQUM7QUFDbEUsUUFBTSxNQUFNO0FBQUEsSUFDVixJQUFJO0FBQUEsTUFDRixRQUFRLFlBQVk7QUFBQSxNQUNwQixRQUFRLENBQUMsU0FBaUIsVUFBa0I7QUFDMUMsc0JBQWMsS0FBSyxFQUFFLFNBQVMsTUFBTSxDQUFDO0FBQUEsTUFDdkM7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLFFBQU0sVUFBVSxNQUFNLGtCQUFrQixlQUFlLEdBQVU7QUFFakUsU0FBTyxNQUFNLFNBQVMsSUFBSTtBQUMxQixTQUFPLE1BQU0sY0FBYyxRQUFRLENBQUM7QUFDcEMsU0FBTyxNQUFNLGNBQWMsQ0FBQyxHQUFHLE9BQU8sTUFBTTtBQUM1QyxTQUFPLE1BQU0sY0FBYyxDQUFDLEdBQUcsV0FBVyxJQUFJLG1CQUFtQjtBQUNuRSxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
