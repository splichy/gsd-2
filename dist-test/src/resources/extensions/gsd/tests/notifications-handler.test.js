import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import { handleNotificationsCommand } from "../commands/handlers/notifications-handler.js";
import {
  _resetNotificationStore,
  appendNotification,
  initNotificationStore
} from "../notification-store.js";
function makeTempDir(prefix) {
  const dir = join(
    tmpdir(),
    `gsd-notifications-handler-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  return dir;
}
function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
  }
}
test("notifications command falls back to text output when overlay returns undefined", async (t) => {
  const base = makeTempDir("overlay-fallback");
  initNotificationStore(base);
  appendNotification("Build complete", "success");
  t.after(() => {
    _resetNotificationStore();
    cleanup(base);
  });
  const notices = [];
  await handleNotificationsCommand(
    "",
    {
      hasUI: true,
      ui: {
        custom: async () => void 0,
        notify: (message, level) => {
          notices.push({ message, level });
        }
      }
    },
    {}
  );
  assert.equal(notices.length, 1, "text fallback should be emitted when overlay cannot render");
  assert.match(notices[0].message, /Recent notifications:/);
});
test("notifications command opens a compact bounded overlay", async (t) => {
  const base = makeTempDir("overlay-options");
  initNotificationStore(base);
  appendNotification("Build complete", "success");
  t.after(() => {
    _resetNotificationStore();
    cleanup(base);
  });
  const notices = [];
  let capturedOptions;
  await handleNotificationsCommand(
    "",
    {
      hasUI: true,
      ui: {
        custom: async (_factory, options) => {
          capturedOptions = options;
          return true;
        },
        notify: (message, level) => {
          notices.push({ message, level });
        }
      }
    },
    {}
  );
  assert.deepEqual(capturedOptions?.overlayOptions, {
    width: "58%",
    minWidth: 68,
    maxHeight: "52%",
    anchor: "top-center",
    row: "24%",
    margin: { top: 2, right: 2, bottom: 6, left: 2 },
    backdrop: true
  });
  assert.equal(notices.length, 0, "successful overlay should not emit text fallback");
});
test("notifications tail caps inline output and hints to open overlay", async (t) => {
  const base = makeTempDir("tail-cap");
  initNotificationStore(base);
  for (let i = 0; i < 55; i++) {
    appendNotification(`notification-${i + 1}`, "info");
  }
  t.after(() => {
    _resetNotificationStore();
    cleanup(base);
  });
  const notices = [];
  await handleNotificationsCommand(
    "tail 200",
    {
      hasUI: true,
      ui: {
        notify: (message, level) => {
          notices.push({ message, level });
        }
      }
    },
    {}
  );
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /Last 40 notification\(s\):/);
  assert.match(notices[0].message, /\.\.\. and \d+ more \(open \/gsd notifications to browse all\)/);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9ub3RpZmljYXRpb25zLWhhbmRsZXIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFRlc3RzIGZvciAvZ3NkIG5vdGlmaWNhdGlvbnMgY29tbWFuZCBoYW5kbGluZyBhbmQgb3ZlcmxheSBsYXVuY2ggYmVoYXZpb3IuXG5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHJtU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5cbmltcG9ydCB7IGhhbmRsZU5vdGlmaWNhdGlvbnNDb21tYW5kIH0gZnJvbSBcIi4uL2NvbW1hbmRzL2hhbmRsZXJzL25vdGlmaWNhdGlvbnMtaGFuZGxlci50c1wiO1xuaW1wb3J0IHtcbiAgX3Jlc2V0Tm90aWZpY2F0aW9uU3RvcmUsXG4gIGFwcGVuZE5vdGlmaWNhdGlvbixcbiAgaW5pdE5vdGlmaWNhdGlvblN0b3JlLFxufSBmcm9tIFwiLi4vbm90aWZpY2F0aW9uLXN0b3JlLnRzXCI7XG5cbmZ1bmN0aW9uIG1ha2VUZW1wRGlyKHByZWZpeDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZGlyID0gam9pbihcbiAgICB0bXBkaXIoKSxcbiAgICBgZ3NkLW5vdGlmaWNhdGlvbnMtaGFuZGxlci10ZXN0LSR7cHJlZml4fS0ke0RhdGUubm93KCl9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YCxcbiAgKTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIG1rZGlyU3luYyhqb2luKGRpciwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGRpcjtcbn1cblxuZnVuY3Rpb24gY2xlYW51cChkaXI6IHN0cmluZyk6IHZvaWQge1xuICB0cnkge1xuICAgIHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gYmVzdC1lZmZvcnRcbiAgfVxufVxuXG50ZXN0KFwibm90aWZpY2F0aW9ucyBjb21tYW5kIGZhbGxzIGJhY2sgdG8gdGV4dCBvdXRwdXQgd2hlbiBvdmVybGF5IHJldHVybnMgdW5kZWZpbmVkXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVGVtcERpcihcIm92ZXJsYXktZmFsbGJhY2tcIik7XG4gIGluaXROb3RpZmljYXRpb25TdG9yZShiYXNlKTtcbiAgYXBwZW5kTm90aWZpY2F0aW9uKFwiQnVpbGQgY29tcGxldGVcIiwgXCJzdWNjZXNzXCIpO1xuXG4gIHQuYWZ0ZXIoKCkgPT4ge1xuICAgIF9yZXNldE5vdGlmaWNhdGlvblN0b3JlKCk7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfSk7XG5cbiAgY29uc3Qgbm90aWNlczogQXJyYXk8eyBtZXNzYWdlOiBzdHJpbmc7IGxldmVsPzogc3RyaW5nIH0+ID0gW107XG4gIGF3YWl0IGhhbmRsZU5vdGlmaWNhdGlvbnNDb21tYW5kKFxuICAgIFwiXCIsXG4gICAge1xuICAgICAgaGFzVUk6IHRydWUsXG4gICAgICB1aToge1xuICAgICAgICBjdXN0b206IGFzeW5jICgpID0+IHVuZGVmaW5lZCxcbiAgICAgICAgbm90aWZ5OiAobWVzc2FnZTogc3RyaW5nLCBsZXZlbD86IHN0cmluZykgPT4ge1xuICAgICAgICAgIG5vdGljZXMucHVzaCh7IG1lc3NhZ2UsIGxldmVsIH0pO1xuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9IGFzIGFueSxcbiAgICB7fSBhcyBhbnksXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKG5vdGljZXMubGVuZ3RoLCAxLCBcInRleHQgZmFsbGJhY2sgc2hvdWxkIGJlIGVtaXR0ZWQgd2hlbiBvdmVybGF5IGNhbm5vdCByZW5kZXJcIik7XG4gIGFzc2VydC5tYXRjaChub3RpY2VzWzBdLm1lc3NhZ2UsIC9SZWNlbnQgbm90aWZpY2F0aW9uczovKTtcbn0pO1xuXG50ZXN0KFwibm90aWZpY2F0aW9ucyBjb21tYW5kIG9wZW5zIGEgY29tcGFjdCBib3VuZGVkIG92ZXJsYXlcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUZW1wRGlyKFwib3ZlcmxheS1vcHRpb25zXCIpO1xuICBpbml0Tm90aWZpY2F0aW9uU3RvcmUoYmFzZSk7XG4gIGFwcGVuZE5vdGlmaWNhdGlvbihcIkJ1aWxkIGNvbXBsZXRlXCIsIFwic3VjY2Vzc1wiKTtcblxuICB0LmFmdGVyKCgpID0+IHtcbiAgICBfcmVzZXROb3RpZmljYXRpb25TdG9yZSgpO1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH0pO1xuXG4gIGNvbnN0IG5vdGljZXM6IEFycmF5PHsgbWVzc2FnZTogc3RyaW5nOyBsZXZlbD86IHN0cmluZyB9PiA9IFtdO1xuICBsZXQgY2FwdHVyZWRPcHRpb25zOiBhbnk7XG4gIGF3YWl0IGhhbmRsZU5vdGlmaWNhdGlvbnNDb21tYW5kKFxuICAgIFwiXCIsXG4gICAge1xuICAgICAgaGFzVUk6IHRydWUsXG4gICAgICB1aToge1xuICAgICAgICBjdXN0b206IGFzeW5jIChfZmFjdG9yeTogYW55LCBvcHRpb25zOiBhbnkpID0+IHtcbiAgICAgICAgICBjYXB0dXJlZE9wdGlvbnMgPSBvcHRpb25zO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuICAgICAgICBub3RpZnk6IChtZXNzYWdlOiBzdHJpbmcsIGxldmVsPzogc3RyaW5nKSA9PiB7XG4gICAgICAgICAgbm90aWNlcy5wdXNoKHsgbWVzc2FnZSwgbGV2ZWwgfSk7XG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0gYXMgYW55LFxuICAgIHt9IGFzIGFueSxcbiAgKTtcblxuICBhc3NlcnQuZGVlcEVxdWFsKGNhcHR1cmVkT3B0aW9ucz8ub3ZlcmxheU9wdGlvbnMsIHtcbiAgICB3aWR0aDogXCI1OCVcIixcbiAgICBtaW5XaWR0aDogNjgsXG4gICAgbWF4SGVpZ2h0OiBcIjUyJVwiLFxuICAgIGFuY2hvcjogXCJ0b3AtY2VudGVyXCIsXG4gICAgcm93OiBcIjI0JVwiLFxuICAgIG1hcmdpbjogeyB0b3A6IDIsIHJpZ2h0OiAyLCBib3R0b206IDYsIGxlZnQ6IDIgfSxcbiAgICBiYWNrZHJvcDogdHJ1ZSxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChub3RpY2VzLmxlbmd0aCwgMCwgXCJzdWNjZXNzZnVsIG92ZXJsYXkgc2hvdWxkIG5vdCBlbWl0IHRleHQgZmFsbGJhY2tcIik7XG59KTtcblxudGVzdChcIm5vdGlmaWNhdGlvbnMgdGFpbCBjYXBzIGlubGluZSBvdXRwdXQgYW5kIGhpbnRzIHRvIG9wZW4gb3ZlcmxheVwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRlbXBEaXIoXCJ0YWlsLWNhcFwiKTtcbiAgaW5pdE5vdGlmaWNhdGlvblN0b3JlKGJhc2UpO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IDU1OyBpKyspIHtcbiAgICBhcHBlbmROb3RpZmljYXRpb24oYG5vdGlmaWNhdGlvbi0ke2kgKyAxfWAsIFwiaW5mb1wiKTtcbiAgfVxuXG4gIHQuYWZ0ZXIoKCkgPT4ge1xuICAgIF9yZXNldE5vdGlmaWNhdGlvblN0b3JlKCk7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfSk7XG5cbiAgY29uc3Qgbm90aWNlczogQXJyYXk8eyBtZXNzYWdlOiBzdHJpbmc7IGxldmVsPzogc3RyaW5nIH0+ID0gW107XG4gIGF3YWl0IGhhbmRsZU5vdGlmaWNhdGlvbnNDb21tYW5kKFxuICAgIFwidGFpbCAyMDBcIixcbiAgICB7XG4gICAgICBoYXNVSTogdHJ1ZSxcbiAgICAgIHVpOiB7XG4gICAgICAgIG5vdGlmeTogKG1lc3NhZ2U6IHN0cmluZywgbGV2ZWw/OiBzdHJpbmcpID0+IHtcbiAgICAgICAgICBub3RpY2VzLnB1c2goeyBtZXNzYWdlLCBsZXZlbCB9KTtcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSBhcyBhbnksXG4gICAge30gYXMgYW55LFxuICApO1xuXG4gIGFzc2VydC5lcXVhbChub3RpY2VzLmxlbmd0aCwgMSk7XG4gIGFzc2VydC5tYXRjaChub3RpY2VzWzBdLm1lc3NhZ2UsIC9MYXN0IDQwIG5vdGlmaWNhdGlvblxcKHNcXCk6Lyk7XG4gIGFzc2VydC5tYXRjaChub3RpY2VzWzBdLm1lc3NhZ2UsIC9cXC5cXC5cXC4gYW5kIFxcZCsgbW9yZSBcXChvcGVuIFxcL2dzZCBub3RpZmljYXRpb25zIHRvIGJyb3dzZSBhbGxcXCkvKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBR0EsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsV0FBVyxjQUFjO0FBRWxDLFNBQVMsa0NBQWtDO0FBQzNDO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUVQLFNBQVMsWUFBWSxRQUF3QjtBQUMzQyxRQUFNLE1BQU07QUFBQSxJQUNWLE9BQU87QUFBQSxJQUNQLGtDQUFrQyxNQUFNLElBQUksS0FBSyxJQUFJLENBQUMsSUFBSSxLQUFLLE9BQU8sRUFBRSxTQUFTLEVBQUUsRUFBRSxNQUFNLEdBQUcsQ0FBQyxDQUFDO0FBQUEsRUFDbEc7QUFDQSxZQUFVLEtBQUssRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNsQyxZQUFVLEtBQUssS0FBSyxNQUFNLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNoRCxTQUFPO0FBQ1Q7QUFFQSxTQUFTLFFBQVEsS0FBbUI7QUFDbEMsTUFBSTtBQUNGLFdBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFP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
