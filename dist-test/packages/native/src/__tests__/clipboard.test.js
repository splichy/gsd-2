import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require2 = createRequire(import.meta.url);
const addonDir = path.resolve(__dirname, "..", "..", "..", "..", "native", "addon");
const platformTag = `${process.platform}-${process.arch}`;
const candidates = [
  path.join(addonDir, `gsd_engine.${platformTag}.node`),
  path.join(addonDir, "gsd_engine.dev.node")
];
let native;
for (const candidate of candidates) {
  try {
    native = require2(candidate);
    break;
  } catch {
  }
}
if (!native) {
  console.error("Native addon not found. Run build:native first.");
  process.exit(1);
}
function isClipboardUnavailableError(error) {
  if (!(error instanceof Error)) return false;
  const message = error.message ?? "";
  return message.includes("Failed to access clipboard") && (message.includes("X11 server connection timed out") || message.includes("X11 server connection") || message.includes("wl-clipboard") || message.includes("No display") || message.includes("DISPLAY"));
}
function skipIfClipboardUnavailable(t, error) {
  if (isClipboardUnavailableError(error)) {
    t.skip(`system clipboard unavailable in this environment: ${error.message}`);
    return;
  }
  throw error;
}
describe("native clipboard: copyToClipboard()", () => {
  test("copies text without throwing", (t) => {
    try {
      native.copyToClipboard("GSD clipboard test");
    } catch (error) {
      skipIfClipboardUnavailable(t, error);
    }
  });
  test("accepts empty string", (t) => {
    try {
      native.copyToClipboard("");
    } catch (error) {
      skipIfClipboardUnavailable(t, error);
    }
  });
  test("accepts unicode text", (t) => {
    try {
      native.copyToClipboard("Hello \u4E16\u754C");
    } catch (error) {
      skipIfClipboardUnavailable(t, error);
    }
  });
});
describe("native clipboard: readTextFromClipboard()", () => {
  test("reads back text that was copied", (t) => {
    try {
      const testText = `GSD clipboard roundtrip ${Date.now()}`;
      native.copyToClipboard(testText);
      const result = native.readTextFromClipboard();
      assert.equal(result, testText);
    } catch (error) {
      skipIfClipboardUnavailable(t, error);
    }
  });
  test("returns a string or null", (t) => {
    try {
      const result = native.readTextFromClipboard();
      assert.ok(result === null || typeof result === "string");
    } catch (error) {
      skipIfClipboardUnavailable(t, error);
    }
  });
});
describe("native clipboard: readImageFromClipboard()", () => {
  test("returns a promise", async (t) => {
    const result = native.readImageFromClipboard();
    assert.ok(result instanceof Promise);
    try {
      await result;
    } catch (error) {
      skipIfClipboardUnavailable(t, error);
    }
  });
  test("resolves to ClipboardImage or null", async (t) => {
    try {
      const result = await native.readImageFromClipboard();
      if (result !== null) {
        assert.ok(result.data instanceof Uint8Array, "data should be Uint8Array");
        assert.equal(result.mimeType, "image/png");
      }
    } catch (error) {
      skipIfClipboardUnavailable(t, error);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvbmF0aXZlL3NyYy9fX3Rlc3RzX18vY2xpcGJvYXJkLnRlc3QubWpzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyB0ZXN0LCBkZXNjcmliZSB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgY3JlYXRlUmVxdWlyZSB9IGZyb20gXCJub2RlOm1vZHVsZVwiO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5cbmNvbnN0IF9fZGlybmFtZSA9IHBhdGguZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuY29uc3QgcmVxdWlyZSA9IGNyZWF0ZVJlcXVpcmUoaW1wb3J0Lm1ldGEudXJsKTtcblxuY29uc3QgYWRkb25EaXIgPSBwYXRoLnJlc29sdmUoX19kaXJuYW1lLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwibmF0aXZlXCIsIFwiYWRkb25cIik7XG5jb25zdCBwbGF0Zm9ybVRhZyA9IGAke3Byb2Nlc3MucGxhdGZvcm19LSR7cHJvY2Vzcy5hcmNofWA7XG5jb25zdCBjYW5kaWRhdGVzID0gW1xuICBwYXRoLmpvaW4oYWRkb25EaXIsIGBnc2RfZW5naW5lLiR7cGxhdGZvcm1UYWd9Lm5vZGVgKSxcbiAgcGF0aC5qb2luKGFkZG9uRGlyLCBcImdzZF9lbmdpbmUuZGV2Lm5vZGVcIiksXG5dO1xuXG5sZXQgbmF0aXZlO1xuZm9yIChjb25zdCBjYW5kaWRhdGUgb2YgY2FuZGlkYXRlcykge1xuICB0cnkge1xuICAgIG5hdGl2ZSA9IHJlcXVpcmUoY2FuZGlkYXRlKTtcbiAgICBicmVhaztcbiAgfSBjYXRjaCB7XG4gICAgLy8gdHJ5IG5leHRcbiAgfVxufVxuXG5pZiAoIW5hdGl2ZSkge1xuICBjb25zb2xlLmVycm9yKFwiTmF0aXZlIGFkZG9uIG5vdCBmb3VuZC4gUnVuIGJ1aWxkOm5hdGl2ZSBmaXJzdC5cIik7XG4gIHByb2Nlc3MuZXhpdCgxKTtcbn1cblxuZnVuY3Rpb24gaXNDbGlwYm9hcmRVbmF2YWlsYWJsZUVycm9yKGVycm9yKSB7XG4gIGlmICghKGVycm9yIGluc3RhbmNlb2YgRXJyb3IpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IG1lc3NhZ2UgPSBlcnJvci5tZXNzYWdlID8/IFwiXCI7XG4gIHJldHVybiAoXG4gICAgbWVzc2FnZS5pbmNsdWRlcyhcIkZhaWxlZCB0byBhY2Nlc3MgY2xpcGJvYXJkXCIpICYmXG4gICAgKFxuICAgICAgbWVzc2FnZS5pbmNsdWRlcyhcIlgxMSBzZXJ2ZXIgY29ubmVjdGlvbiB0aW1lZCBvdXRcIikgfHxcbiAgICAgIG1lc3NhZ2UuaW5jbHVkZXMoXCJYMTEgc2VydmVyIGNvbm5lY3Rpb25cIikgfHxcbiAgICAgIG1lc3NhZ2UuaW5jbHVkZXMoXCJ3bC1jbGlwYm9hcmRcIikgfHxcbiAgICAgIG1lc3NhZ2UuaW5jbHVkZXMoXCJObyBkaXNwbGF5XCIpIHx8XG4gICAgICBtZXNzYWdlLmluY2x1ZGVzKFwiRElTUExBWVwiKVxuICAgIClcbiAgKTtcbn1cblxuZnVuY3Rpb24gc2tpcElmQ2xpcGJvYXJkVW5hdmFpbGFibGUodCwgZXJyb3IpIHtcbiAgaWYgKGlzQ2xpcGJvYXJkVW5hdmFpbGFibGVFcnJvcihlcnJvcikpIHtcbiAgICB0LnNraXAoYHN5c3RlbSBjbGlwYm9hcmQgdW5hdmFpbGFibGUgaW4gdGhpcyBlbnZpcm9ubWVudDogJHtlcnJvci5tZXNzYWdlfWApO1xuICAgIHJldHVybjtcbiAgfVxuICB0aHJvdyBlcnJvcjtcbn1cblxuZGVzY3JpYmUoXCJuYXRpdmUgY2xpcGJvYXJkOiBjb3B5VG9DbGlwYm9hcmQoKVwiLCAoKSA9PiB7XG4gIHRlc3QoXCJjb3BpZXMgdGV4dCB3aXRob3V0IHRocm93aW5nXCIsICh0KSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIG5hdGl2ZS5jb3B5VG9DbGlwYm9hcmQoXCJHU0QgY2xpcGJvYXJkIHRlc3RcIik7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHNraXBJZkNsaXBib2FyZFVuYXZhaWxhYmxlKHQsIGVycm9yKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJhY2NlcHRzIGVtcHR5IHN0cmluZ1wiLCAodCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICBuYXRpdmUuY29weVRvQ2xpcGJvYXJkKFwiXCIpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBza2lwSWZDbGlwYm9hcmRVbmF2YWlsYWJsZSh0LCBlcnJvcik7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiYWNjZXB0cyB1bmljb2RlIHRleHRcIiwgKHQpID0+IHtcbiAgICB0cnkge1xuICAgICAgbmF0aXZlLmNvcHlUb0NsaXBib2FyZChcIkhlbGxvIFx1NEUxNlx1NzU0Q1wiKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgc2tpcElmQ2xpcGJvYXJkVW5hdmFpbGFibGUodCwgZXJyb3IpO1xuICAgIH1cbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJuYXRpdmUgY2xpcGJvYXJkOiByZWFkVGV4dEZyb21DbGlwYm9hcmQoKVwiLCAoKSA9PiB7XG4gIHRlc3QoXCJyZWFkcyBiYWNrIHRleHQgdGhhdCB3YXMgY29waWVkXCIsICh0KSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHRlc3RUZXh0ID0gYEdTRCBjbGlwYm9hcmQgcm91bmR0cmlwICR7RGF0ZS5ub3coKX1gO1xuICAgICAgbmF0aXZlLmNvcHlUb0NsaXBib2FyZCh0ZXN0VGV4dCk7XG4gICAgICBjb25zdCByZXN1bHQgPSBuYXRpdmUucmVhZFRleHRGcm9tQ2xpcGJvYXJkKCk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCB0ZXN0VGV4dCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHNraXBJZkNsaXBib2FyZFVuYXZhaWxhYmxlKHQsIGVycm9yKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXR1cm5zIGEgc3RyaW5nIG9yIG51bGxcIiwgKHQpID0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gbmF0aXZlLnJlYWRUZXh0RnJvbUNsaXBib2FyZCgpO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdCA9PT0gbnVsbCB8fCB0eXBlb2YgcmVzdWx0ID09PSBcInN0cmluZ1wiKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgc2tpcElmQ2xpcGJvYXJkVW5hdmFpbGFibGUodCwgZXJyb3IpO1xuICAgIH1cbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJuYXRpdmUgY2xpcGJvYXJkOiByZWFkSW1hZ2VGcm9tQ2xpcGJvYXJkKClcIiwgKCkgPT4ge1xuICB0ZXN0KFwicmV0dXJucyBhIHByb21pc2VcIiwgYXN5bmMgKHQpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBuYXRpdmUucmVhZEltYWdlRnJvbUNsaXBib2FyZCgpO1xuICAgIGFzc2VydC5vayhyZXN1bHQgaW5zdGFuY2VvZiBQcm9taXNlKTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgcmVzdWx0O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBza2lwSWZDbGlwYm9hcmRVbmF2YWlsYWJsZSh0LCBlcnJvcik7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwicmVzb2x2ZXMgdG8gQ2xpcGJvYXJkSW1hZ2Ugb3IgbnVsbFwiLCBhc3luYyAodCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBuYXRpdmUucmVhZEltYWdlRnJvbUNsaXBib2FyZCgpO1xuICAgICAgaWYgKHJlc3VsdCAhPT0gbnVsbCkge1xuICAgICAgICBhc3NlcnQub2socmVzdWx0LmRhdGEgaW5zdGFuY2VvZiBVaW50OEFycmF5LCBcImRhdGEgc2hvdWxkIGJlIFVpbnQ4QXJyYXlcIik7XG4gICAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQubWltZVR5cGUsIFwiaW1hZ2UvcG5nXCIpO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBza2lwSWZDbGlwYm9hcmRVbmF2YWlsYWJsZSh0LCBlcnJvcik7XG4gICAgfVxuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxNQUFNLGdCQUFnQjtBQUMvQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxxQkFBcUI7QUFDOUIsWUFBWSxVQUFVO0FBQ3RCLFNBQVMscUJBQXFCO0FBRTlCLE1BQU0sWUFBWSxLQUFLLFFBQVEsY0FBYyxZQUFZLEdBQUcsQ0FBQztBQUM3RCxNQUFNQSxXQUFVLGNBQWMsWUFBWSxHQUFHO0FBRTdDLE1BQU0sV0FBVyxLQUFLLFFBQVEsV0FBVyxNQUFNLE1BQU0sTUFBTSxNQUFNLFVBQVUsT0FBTztBQUNsRixNQUFNLGNBQWMsR0FBRyxRQUFRLFFBQVEsSUFBSSxRQUFRLElBQUk7QUFDdkQsTUFBTSxhQUFhO0FBQUEsRUFDakIsS0FBSyxLQUFLLFVBQVUsY0FBYyxXQUFXLE9BQU87QUFBQSxFQUNwRCxLQUFLLEtBQUssVUFBVSxxQkFBcUI7QUFDM0M7QUFFQSxJQUFJO0FBQ0osV0FBVyxhQUFhLFlBQVk7QUFDbEMsTUFBSTtBQUNGLGFBQVNBLFNBQVEsU0FBUztBQUMxQjtBQUFBLEVBQ0YsUUFBUTtBQUFBLEVBRVI7QUFDRjtBQUVBLElBQUksQ0FBQyxRQUFRO0FBQ1gsVUFBUSxNQUFNLGlEQUFpRDtBQUMvRCxVQUFRLEtBQUssQ0FBQztBQUNoQjtBQUVBLFNBQVMsNEJBQTRCLE9BQU87QUFDMUMsTUFBSSxFQUFFLGlCQUFpQixPQUFRLFFBQU87QUFDdEMsUUFBTSxVQUFVLE1BQU0sV0FBVztBQUNqQyxTQUNFLFFBQVEsU0FBUyw0QkFBNEIsTUFFM0MsUUFBUSxTQUFTLGlDQUFpQyxLQUNsRCxRQUFRLFNBQVMsdUJBQXVCLEtBQ3hDLFFBQVEsU0FBUyxjQUFjLEtBQy9CLFFBQVEsU0FBUyxZQUFZLEtBQzdCLFFBQVEsU0FBUyxTQUFTO0FBR2hDO0FBRUEsU0FBUywyQkFBMkIsR0FBRyxPQUFPO0FBQzVDLE1BQUksNEJBQTRCLEtBQUssR0FBRztBQUN0QyxNQUFFLEtBQUsscURBQXFELE1BQU0sT0FBTyxFQUFFO0FBQzNFO0FBQUEsRUFDRjtBQUNBLFFBQU07QUFDUjtBQUVBLFNBQVMsdUNBQXVDLE1BQU07QUFDcEQsT0FBSyxnQ0FBZ0MsQ0FBQyxNQUFNO0FBQzFDLFFBQUk7QUFDRixhQUFPLGdCQUFnQixvQkFBb0I7QUFBQSxJQUM3QyxTQUFTLE9BQU87QUFDZCxpQ0FBMkIsR0FBRyxLQUFLO0FBQUEsSUFDckM7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLHdCQUF3QixDQUFDLE1BQU07QUFDbEMsUUFBSTtBQUNGLGFBQU8sZ0JBQWdCLEVBQUU7QUFBQSxJQUMzQixTQUFTLE9BQU87QUFDZCxpQ0FBMkIsR0FBRyxLQUFLO0FBQUEsSUFDckM7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLHdCQUF3QixDQUFDLE1BQU07QUFDbEMsUUFBSTtBQUNGLGFBQU8sZ0JBQWdCLG9CQUFVO0FBQUEsSUFDbkMsU0FBUyxPQUFPO0FBQ2QsaUNBQTJCLEdBQUcsS0FBSztBQUFBLElBQ3JDO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQztBQUVELFNBQVMsNkNBQTZDLE1BQU07QUFDMUQsT0FBSyxtQ0FBbUMsQ0FBQyxNQUFNO0FBQzdDLFFBQUk7QUFDRixZQUFNLFdBQVcsMkJBQTJCLEtBQUssSUFBSSxDQUFDO0FBQ3RELGFBQU8sZ0JBQWdCLFFBQVE7QUFDL0IsWUFBTSxTQUFTLE9BQU8sc0JBQXNCO0FBQzVDLGFBQU8sTUFBTSxRQUFRLFFBQVE7QUFBQSxJQUMvQixTQUFTLE9BQU87QUFDZCxpQ0FBMkIsR0FBRyxLQUFLO0FBQUEsSUFDckM7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLDRCQUE0QixDQUFDLE1BQU07QUFDdEMsUUFBSTtBQUNGLFlBQU0sU0FBUyxPQUFPLHNCQUFzQjtBQUM1QyxhQUFPLEdBQUcsV0FBVyxRQUFRLE9BQU8sV0FBVyxRQUFRO0FBQUEsSUFDekQsU0FBUyxPQUFPO0FBQ2QsaUNBQTJCLEdBQUcsS0FBSztBQUFBLElBQ3JDO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQztBQUVELFNBQVMsOENBQThDLE1BQU07QUFDM0QsT0FBSyxxQkFBcUIsT0FBTyxNQUFNO0FBQ3JDLFVBQU0sU0FBUyxPQUFPLHVCQUF1QjtBQUM3QyxXQUFPLEdBQUcsa0JBQWtCLE9BQU87QUFDbkMsUUFBSTtBQUNGLFlBQU07QUFBQSxJQUNSLFNBQVMsT0FBTztBQUNkLGlDQUEyQixHQUFHLEtBQUs7QUFBQSxJQUNyQztBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssc0NBQXNDLE9BQU8sTUFBTTtBQUN0RCxRQUFJO0FBQ0YsWUFBTSxTQUFTLE1BQU0sT0FBTyx1QkFBdUI7QUFDbkQsVUFBSSxXQUFXLE1BQU07QUFDbkIsZUFBTyxHQUFHLE9BQU8sZ0JBQWdCLFlBQVksMkJBQTJCO0FBQ3hFLGVBQU8sTUFBTSxPQUFPLFVBQVUsV0FBVztBQUFBLE1BQzNDO0FBQUEsSUFDRixTQUFTLE9BQU87QUFDZCxpQ0FBMkIsR0FBRyxLQUFLO0FBQUEsSUFDckM7QUFBQSxFQUNGLENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogWyJyZXF1aXJlIl0KfQo=
