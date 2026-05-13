import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerShortcuts } from "../bootstrap/register-shortcuts.js";
function makeTempDir(prefix) {
  const dir = join(
    tmpdir(),
    `gsd-register-shortcuts-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
  }
}
test("dashboard shortcut resolves the project root instead of the current worktree path", async (t) => {
  const projectRoot = makeTempDir("project");
  const worktreeRoot = join(projectRoot, ".gsd", "worktrees", "M001");
  mkdirSync(join(projectRoot, ".gsd"), { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  const originalCwd = process.cwd();
  process.chdir(worktreeRoot);
  t.after(() => {
    process.chdir(originalCwd);
    cleanup(projectRoot);
  });
  let capturedHandler = null;
  const shortcuts = [];
  const pi = {
    registerShortcut: (key, shortcut) => {
      shortcuts.push({ key: String(key), ...shortcut });
      if (!capturedHandler) {
        capturedHandler = shortcut.handler;
      }
    }
  };
  registerShortcuts(pi);
  assert.ok(capturedHandler, "dashboard shortcut is registered");
  const dashboardShortcut = shortcuts[0];
  assert.ok(dashboardShortcut, "dashboard shortcut is captured");
  let customCalls = 0;
  const notices = [];
  await dashboardShortcut.handler({
    hasUI: true,
    ui: {
      custom: async () => {
        customCalls++;
        return true;
      },
      notify: (message, type) => {
        notices.push({ message, type });
      }
    }
  });
  assert.ok(customCalls > 0, "shortcut opens the dashboard overlay when project root is resolved");
  assert.equal(notices.length, 0, "shortcut does not fall back to the missing-.gsd warning");
  assert.equal(shortcuts.length, 5, "all GSD shortcuts are still registered");
  const keys = shortcuts.map((shortcut) => shortcut.key);
  assert.ok(keys.includes("ctrl+alt+g"), "primary dashboard shortcut is registered");
  assert.ok(keys.includes("ctrl+shift+g"), "fallback dashboard shortcut is registered");
  assert.ok(keys.includes("ctrl+alt+n"), "primary notifications shortcut is registered");
  assert.ok(keys.includes("ctrl+shift+n"), "fallback notifications shortcut is registered");
  assert.ok(keys.includes("ctrl+alt+p"), "primary parallel shortcut is registered");
  assert.ok(!keys.includes("ctrl+shift+p"), "parallel fallback must not be registered (conflicts with cycleModelBackward)");
});
test("parallel shortcut passes resolved project root into overlay", async (t) => {
  const base = makeTempDir("parallel-root");
  const worktreeRoot = join(base, ".gsd", "worktrees", "M001");
  mkdirSync(join(base, ".gsd", "parallel"), { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  const originalCwd = process.cwd();
  process.chdir(worktreeRoot);
  t.after(() => {
    process.chdir(originalCwd);
    cleanup(base);
  });
  const shortcuts = [];
  registerShortcuts({
    registerShortcut: (key, shortcut) => {
      shortcuts.push({ key: String(key), ...shortcut });
    }
  });
  const parallelShortcut = shortcuts.find((shortcut) => shortcut.key === "ctrl+alt+p");
  assert.ok(parallelShortcut, "parallel shortcut is registered");
  let capturedBasePath;
  await parallelShortcut.handler({
    hasUI: true,
    ui: {
      custom: async (factory) => {
        const overlay = factory(
          { requestRender() {
          } },
          { fg: (_color, text) => text, bold: (text) => text },
          null,
          () => {
          }
        );
        capturedBasePath = overlay.basePath;
        overlay.dispose?.();
        return true;
      },
      notify: () => {
      }
    }
  });
  assert.ok(capturedBasePath, "parallel shortcut should construct overlay with a basePath");
  assert.equal(
    realpathSync(capturedBasePath),
    realpathSync(base),
    "parallel overlay should use the resolved project root, not the worktree cwd"
  );
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9yZWdpc3Rlci1zaG9ydGN1dHMudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHJlYWxwYXRoU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyByZWdpc3RlclNob3J0Y3V0cyB9IGZyb20gXCIuLi9ib290c3RyYXAvcmVnaXN0ZXItc2hvcnRjdXRzLnRzXCI7XG5cbmZ1bmN0aW9uIG1ha2VUZW1wRGlyKHByZWZpeDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZGlyID0gam9pbihcbiAgICB0bXBkaXIoKSxcbiAgICBgZ3NkLXJlZ2lzdGVyLXNob3J0Y3V0cy10ZXN0LSR7cHJlZml4fS0ke0RhdGUubm93KCl9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YCxcbiAgKTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBkaXI7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoZGlyOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIGJlc3QtZWZmb3J0XG4gIH1cbn1cblxudGVzdChcImRhc2hib2FyZCBzaG9ydGN1dCByZXNvbHZlcyB0aGUgcHJvamVjdCByb290IGluc3RlYWQgb2YgdGhlIGN1cnJlbnQgd29ya3RyZWUgcGF0aFwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBwcm9qZWN0Um9vdCA9IG1ha2VUZW1wRGlyKFwicHJvamVjdFwiKTtcbiAgY29uc3Qgd29ya3RyZWVSb290ID0gam9pbihwcm9qZWN0Um9vdCwgXCIuZ3NkXCIsIFwid29ya3RyZWVzXCIsIFwiTTAwMVwiKTtcbiAgbWtkaXJTeW5jKGpvaW4ocHJvamVjdFJvb3QsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIG1rZGlyU3luYyh3b3JrdHJlZVJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIGNvbnN0IG9yaWdpbmFsQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgcHJvY2Vzcy5jaGRpcih3b3JrdHJlZVJvb3QpO1xuICB0LmFmdGVyKCgpID0+IHtcbiAgICBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQ3dkKTtcbiAgICBjbGVhbnVwKHByb2plY3RSb290KTtcbiAgfSk7XG5cbiAgbGV0IGNhcHR1cmVkSGFuZGxlcjogKChjdHg6IGFueSkgPT4gUHJvbWlzZTx2b2lkPikgfCBudWxsID0gbnVsbDtcbiAgY29uc3Qgc2hvcnRjdXRzOiBBcnJheTx7IGtleTogc3RyaW5nOyBkZXNjcmlwdGlvbjogc3RyaW5nOyBoYW5kbGVyOiAoY3R4OiBhbnkpID0+IFByb21pc2U8dm9pZD4gfT4gPSBbXTtcbiAgY29uc3QgcGkgPSB7XG4gICAgcmVnaXN0ZXJTaG9ydGN1dDogKGtleTogdW5rbm93biwgc2hvcnRjdXQ6IHsgZGVzY3JpcHRpb246IHN0cmluZzsgaGFuZGxlcjogKGN0eDogYW55KSA9PiBQcm9taXNlPHZvaWQ+IH0pID0+IHtcbiAgICAgIHNob3J0Y3V0cy5wdXNoKHsga2V5OiBTdHJpbmcoa2V5KSwgLi4uc2hvcnRjdXQgfSk7XG4gICAgICBpZiAoIWNhcHR1cmVkSGFuZGxlcikge1xuICAgICAgICBjYXB0dXJlZEhhbmRsZXIgPSBzaG9ydGN1dC5oYW5kbGVyO1xuICAgICAgfVxuICAgIH0sXG4gIH0gYXMgYW55O1xuXG4gIHJlZ2lzdGVyU2hvcnRjdXRzKHBpKTtcbiAgYXNzZXJ0Lm9rKGNhcHR1cmVkSGFuZGxlciwgXCJkYXNoYm9hcmQgc2hvcnRjdXQgaXMgcmVnaXN0ZXJlZFwiKTtcbiAgY29uc3QgZGFzaGJvYXJkU2hvcnRjdXQgPSBzaG9ydGN1dHNbMF07XG4gIGFzc2VydC5vayhkYXNoYm9hcmRTaG9ydGN1dCwgXCJkYXNoYm9hcmQgc2hvcnRjdXQgaXMgY2FwdHVyZWRcIik7XG5cbiAgbGV0IGN1c3RvbUNhbGxzID0gMDtcbiAgY29uc3Qgbm90aWNlczogQXJyYXk8eyBtZXNzYWdlOiBzdHJpbmc7IHR5cGU/OiBzdHJpbmcgfT4gPSBbXTtcbiAgYXdhaXQgZGFzaGJvYXJkU2hvcnRjdXQuaGFuZGxlcih7XG4gICAgaGFzVUk6IHRydWUsXG4gICAgdWk6IHtcbiAgICAgIGN1c3RvbTogYXN5bmMgKCkgPT4ge1xuICAgICAgICBjdXN0b21DYWxscysrO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0sXG4gICAgICBub3RpZnk6IChtZXNzYWdlOiBzdHJpbmcsIHR5cGU/OiBzdHJpbmcpID0+IHtcbiAgICAgICAgbm90aWNlcy5wdXNoKHsgbWVzc2FnZSwgdHlwZSB9KTtcbiAgICAgIH0sXG4gICAgfSxcbiAgfSk7XG5cbiAgYXNzZXJ0Lm9rKGN1c3RvbUNhbGxzID4gMCwgXCJzaG9ydGN1dCBvcGVucyB0aGUgZGFzaGJvYXJkIG92ZXJsYXkgd2hlbiBwcm9qZWN0IHJvb3QgaXMgcmVzb2x2ZWRcIik7XG4gIGFzc2VydC5lcXVhbChub3RpY2VzLmxlbmd0aCwgMCwgXCJzaG9ydGN1dCBkb2VzIG5vdCBmYWxsIGJhY2sgdG8gdGhlIG1pc3NpbmctLmdzZCB3YXJuaW5nXCIpO1xuICBhc3NlcnQuZXF1YWwoc2hvcnRjdXRzLmxlbmd0aCwgNSwgXCJhbGwgR1NEIHNob3J0Y3V0cyBhcmUgc3RpbGwgcmVnaXN0ZXJlZFwiKTtcbiAgY29uc3Qga2V5cyA9IHNob3J0Y3V0cy5tYXAoKHNob3J0Y3V0KSA9PiBzaG9ydGN1dC5rZXkpO1xuICBhc3NlcnQub2soa2V5cy5pbmNsdWRlcyhcImN0cmwrYWx0K2dcIiksIFwicHJpbWFyeSBkYXNoYm9hcmQgc2hvcnRjdXQgaXMgcmVnaXN0ZXJlZFwiKTtcbiAgYXNzZXJ0Lm9rKGtleXMuaW5jbHVkZXMoXCJjdHJsK3NoaWZ0K2dcIiksIFwiZmFsbGJhY2sgZGFzaGJvYXJkIHNob3J0Y3V0IGlzIHJlZ2lzdGVyZWRcIik7XG4gIGFzc2VydC5vayhrZXlzLmluY2x1ZGVzKFwiY3RybCthbHQrblwiKSwgXCJwcmltYXJ5IG5vdGlmaWNhdGlvbnMgc2hvcnRjdXQgaXMgcmVnaXN0ZXJlZFwiKTtcbiAgYXNzZXJ0Lm9rKGtleXMuaW5jbHVkZXMoXCJjdHJsK3NoaWZ0K25cIiksIFwiZmFsbGJhY2sgbm90aWZpY2F0aW9ucyBzaG9ydGN1dCBpcyByZWdpc3RlcmVkXCIpO1xuICBhc3NlcnQub2soa2V5cy5pbmNsdWRlcyhcImN0cmwrYWx0K3BcIiksIFwicHJpbWFyeSBwYXJhbGxlbCBzaG9ydGN1dCBpcyByZWdpc3RlcmVkXCIpO1xuICAvLyBObyBDdHJsK1NoaWZ0K1AgZmFsbGJhY2sgXHUyMDE0IGNvbmZsaWN0cyB3aXRoIGN5Y2xlTW9kZWxCYWNrd2FyZCAoc2hpZnQrY3RybCtwKVxuICBhc3NlcnQub2soIWtleXMuaW5jbHVkZXMoXCJjdHJsK3NoaWZ0K3BcIiksIFwicGFyYWxsZWwgZmFsbGJhY2sgbXVzdCBub3QgYmUgcmVnaXN0ZXJlZCAoY29uZmxpY3RzIHdpdGggY3ljbGVNb2RlbEJhY2t3YXJkKVwiKTtcbn0pO1xuXG50ZXN0KFwicGFyYWxsZWwgc2hvcnRjdXQgcGFzc2VzIHJlc29sdmVkIHByb2plY3Qgcm9vdCBpbnRvIG92ZXJsYXlcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUZW1wRGlyKFwicGFyYWxsZWwtcm9vdFwiKTtcbiAgY29uc3Qgd29ya3RyZWVSb290ID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiwgXCJNMDAxXCIpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJwYXJhbGxlbFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIG1rZGlyU3luYyh3b3JrdHJlZVJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIGNvbnN0IG9yaWdpbmFsQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgcHJvY2Vzcy5jaGRpcih3b3JrdHJlZVJvb3QpO1xuICB0LmFmdGVyKCgpID0+IHtcbiAgICBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQ3dkKTtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9KTtcblxuICBjb25zdCBzaG9ydGN1dHM6IEFycmF5PHsga2V5OiBzdHJpbmc7IGRlc2NyaXB0aW9uOiBzdHJpbmc7IGhhbmRsZXI6IChjdHg6IGFueSkgPT4gUHJvbWlzZTx2b2lkPiB9PiA9IFtdO1xuICByZWdpc3RlclNob3J0Y3V0cyh7XG4gICAgcmVnaXN0ZXJTaG9ydGN1dDogKGtleTogdW5rbm93biwgc2hvcnRjdXQ6IHsgZGVzY3JpcHRpb246IHN0cmluZzsgaGFuZGxlcjogKGN0eDogYW55KSA9PiBQcm9taXNlPHZvaWQ+IH0pID0+IHtcbiAgICAgIHNob3J0Y3V0cy5wdXNoKHsga2V5OiBTdHJpbmcoa2V5KSwgLi4uc2hvcnRjdXQgfSk7XG4gICAgfSxcbiAgfSBhcyBhbnkpO1xuXG4gIGNvbnN0IHBhcmFsbGVsU2hvcnRjdXQgPSBzaG9ydGN1dHMuZmluZCgoc2hvcnRjdXQpID0+IHNob3J0Y3V0LmtleSA9PT0gXCJjdHJsK2FsdCtwXCIpO1xuICBhc3NlcnQub2socGFyYWxsZWxTaG9ydGN1dCwgXCJwYXJhbGxlbCBzaG9ydGN1dCBpcyByZWdpc3RlcmVkXCIpO1xuXG4gIGxldCBjYXB0dXJlZEJhc2VQYXRoOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGF3YWl0IHBhcmFsbGVsU2hvcnRjdXQhLmhhbmRsZXIoe1xuICAgIGhhc1VJOiB0cnVlLFxuICAgIHVpOiB7XG4gICAgICBjdXN0b206IGFzeW5jIChmYWN0b3J5OiBhbnkpID0+IHtcbiAgICAgICAgY29uc3Qgb3ZlcmxheSA9IGZhY3RvcnkoXG4gICAgICAgICAgeyByZXF1ZXN0UmVuZGVyKCkge30gfSxcbiAgICAgICAgICB7IGZnOiAoX2NvbG9yOiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4gdGV4dCwgYm9sZDogKHRleHQ6IHN0cmluZykgPT4gdGV4dCB9LFxuICAgICAgICAgIG51bGwsXG4gICAgICAgICAgKCkgPT4ge30sXG4gICAgICAgICk7XG4gICAgICAgIGNhcHR1cmVkQmFzZVBhdGggPSAob3ZlcmxheSBhcyBhbnkpLmJhc2VQYXRoO1xuICAgICAgICBvdmVybGF5LmRpc3Bvc2U/LigpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0sXG4gICAgICBub3RpZnk6ICgpID0+IHt9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGFzc2VydC5vayhjYXB0dXJlZEJhc2VQYXRoLCBcInBhcmFsbGVsIHNob3J0Y3V0IHNob3VsZCBjb25zdHJ1Y3Qgb3ZlcmxheSB3aXRoIGEgYmFzZVBhdGhcIik7XG4gIGFzc2VydC5lcXVhbChcbiAgICByZWFscGF0aFN5bmMoY2FwdHVyZWRCYXNlUGF0aCksXG4gICAgcmVhbHBhdGhTeW5jKGJhc2UpLFxuICAgIFwicGFyYWxsZWwgb3ZlcmxheSBzaG91bGQgdXNlIHRoZSByZXNvbHZlZCBwcm9qZWN0IHJvb3QsIG5vdCB0aGUgd29ya3RyZWUgY3dkXCIsXG4gICk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxXQUFXLGNBQWMsY0FBYztBQUNoRCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBRXZCLFNBQVMseUJBQXlCO0FBRWxDLFNBQVMsWUFBWSxRQUF3QjtBQUMzQyxRQUFNLE1BQU07QUFBQSxJQUNWLE9BQU87QUFBQSxJQUNQLCtCQUErQixNQUFNLElBQUksS0FBSyxJQUFJLENBQUMsSUFBSSxL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
