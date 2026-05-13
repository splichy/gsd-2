import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { ProviderManagerComponent } from "../../packages/pi-coding-agent/src/modes/interactive/components/provider-manager.js";
import { initTheme } from "../../packages/pi-coding-agent/src/modes/interactive/theme/theme.js";
initTheme("dark", false);
function createProviderManager(onSetupAuth) {
  return new ProviderManagerComponent(
    { requestRender: () => {
    } },
    { hasAuth: () => false },
    {
      modelsJsonPath: void 0,
      getAll: () => [{ provider: "anthropic", api: "anthropic-messages" }]
    },
    () => {
    },
    () => {
    },
    onSetupAuth
  );
}
describe("provider manager Enter key handler (#3579)", () => {
  test("Enter initiates auth setup for the selected provider", () => {
    let selectedProvider;
    const manager = createProviderManager((provider) => {
      selectedProvider = provider;
    });
    manager.handleInput("\r");
    assert.equal(selectedProvider, "anthropic");
  });
  test("setup auth hint is rendered", () => {
    const manager = createProviderManager(() => {
    });
    const text = manager.render(100).map((line) => stripVTControlCharacters(line)).join("\n");
    assert.match(text, /enter/);
    assert.match(text, /setup auth/);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL3Byb3ZpZGVyLW1hbmFnZXItZW50ZXIta2V5LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBzdHJpcFZUQ29udHJvbENoYXJhY3RlcnMgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5pbXBvcnQgeyBQcm92aWRlck1hbmFnZXJDb21wb25lbnQgfSBmcm9tIFwiLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9jb21wb25lbnRzL3Byb3ZpZGVyLW1hbmFnZXIudHNcIjtcbmltcG9ydCB7IGluaXRUaGVtZSB9IGZyb20gXCIuLi8uLi9wYWNrYWdlcy9waS1jb2RpbmctYWdlbnQvc3JjL21vZGVzL2ludGVyYWN0aXZlL3RoZW1lL3RoZW1lLnRzXCI7XG5cbmluaXRUaGVtZShcImRhcmtcIiwgZmFsc2UpO1xuXG5mdW5jdGlvbiBjcmVhdGVQcm92aWRlck1hbmFnZXIob25TZXR1cEF1dGg6IChwcm92aWRlcjogc3RyaW5nKSA9PiB2b2lkKSB7XG5cdHJldHVybiBuZXcgUHJvdmlkZXJNYW5hZ2VyQ29tcG9uZW50KFxuXHRcdHsgcmVxdWVzdFJlbmRlcjogKCkgPT4ge30gfSBhcyBhbnksXG5cdFx0eyBoYXNBdXRoOiAoKSA9PiBmYWxzZSB9IGFzIGFueSxcblx0XHR7XG5cdFx0XHRtb2RlbHNKc29uUGF0aDogdW5kZWZpbmVkLFxuXHRcdFx0Z2V0QWxsOiAoKSA9PiBbeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiIH1dLFxuXHRcdH0gYXMgYW55LFxuXHRcdCgpID0+IHt9LFxuXHRcdCgpID0+IHt9LFxuXHRcdG9uU2V0dXBBdXRoLFxuXHQpO1xufVxuXG5kZXNjcmliZShcInByb3ZpZGVyIG1hbmFnZXIgRW50ZXIga2V5IGhhbmRsZXIgKCMzNTc5KVwiLCAoKSA9PiB7XG5cdHRlc3QoXCJFbnRlciBpbml0aWF0ZXMgYXV0aCBzZXR1cCBmb3IgdGhlIHNlbGVjdGVkIHByb3ZpZGVyXCIsICgpID0+IHtcblx0XHRsZXQgc2VsZWN0ZWRQcm92aWRlcjogc3RyaW5nIHwgdW5kZWZpbmVkO1xuXHRcdGNvbnN0IG1hbmFnZXIgPSBjcmVhdGVQcm92aWRlck1hbmFnZXIoKHByb3ZpZGVyKSA9PiB7XG5cdFx0XHRzZWxlY3RlZFByb3ZpZGVyID0gcHJvdmlkZXI7XG5cdFx0fSk7XG5cblx0XHRtYW5hZ2VyLmhhbmRsZUlucHV0KFwiXFxyXCIpO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKHNlbGVjdGVkUHJvdmlkZXIsIFwiYW50aHJvcGljXCIpO1xuXHR9KTtcblxuXHR0ZXN0KFwic2V0dXAgYXV0aCBoaW50IGlzIHJlbmRlcmVkXCIsICgpID0+IHtcblx0XHRjb25zdCBtYW5hZ2VyID0gY3JlYXRlUHJvdmlkZXJNYW5hZ2VyKCgpID0+IHt9KTtcblx0XHRjb25zdCB0ZXh0ID0gbWFuYWdlci5yZW5kZXIoMTAwKS5tYXAoKGxpbmUpID0+IHN0cmlwVlRDb250cm9sQ2hhcmFjdGVycyhsaW5lKSkuam9pbihcIlxcblwiKTtcblxuXHRcdGFzc2VydC5tYXRjaCh0ZXh0LCAvZW50ZXIvKTtcblx0XHRhc3NlcnQubWF0Y2godGV4dCwgL3NldHVwIGF1dGgvKTtcblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsVUFBVSxZQUFZO0FBQy9CLE9BQU8sWUFBWTtBQUNuQixTQUFTLGdDQUFnQztBQUN6QyxTQUFTLGdDQUFnQztBQUN6QyxTQUFTLGlCQUFpQjtBQUUxQixVQUFVLFFBQVEsS0FBSztBQUV2QixTQUFTLHNCQUFzQixhQUF5QztBQUN2RSxTQUFPLElBQUk7QUFBQSxJQUNWLEVBQUUsZUFBZSxNQUFNO0FBQUEsSUFBQyxFQUFFO0FBQUEsSUFDMUIsRUFBRSxTQUFTLE1BQU0sTUFBTTtBQUFBLElBQ3ZCO0FBQUEsTUFDQyxnQkFBZ0I7QUFBQSxNQUNoQixRQUFRLE1BQU0sQ0FBQyxFQUFFLFVBQVUsYUFBYSxLQUFLLHFCQUFxQixDQUFDO0FBQUEsSUFDcEU7QUFBQSxJQUNBLE1BQU07QUFBQSxJQUFDO0FBQUEsSUFDUCxNQUFNO0FBQUEsSUFBQztBQUFBLElBQ1A7QUFBQSxFQUNEO0FBQ0Q7QUFFQSxTQUFTLDhDQUE4QyxNQUFNO0FBQzVELE9BQUssd0RBQXdELE1BQU07QUFDbEUsUUFBSTtBQUNKLFVBQU0sVUFBVSxzQkFBc0IsQ0FBQyxhQUFhO0FBQ25ELHlCQUFtQjtBQUFBLElBQ3BCLENBQUM7QUFFRCxZQUFRLFlBQVksSUFBSTtBQUV4QixXQUFPLE1BQU0sa0JBQWtCLFdBQVc7QUFBQSxFQUMzQyxDQUFDO0FBRUQsT0FBSywrQkFBK0IsTUFBTTtBQUN6QyxVQUFNLFVBQVUsc0JBQXNCLE1BQU07QUFBQSxJQUFDLENBQUM7QUFDOUMsVUFBTSxPQUFPLFFBQVEsT0FBTyxHQUFHLEVBQUUsSUFBSSxDQUFDLFNBQVMseUJBQXlCLElBQUksQ0FBQyxFQUFFLEtBQUssSUFBSTtBQUV4RixXQUFPLE1BQU0sTUFBTSxPQUFPO0FBQzFCLFdBQU8sTUFBTSxNQUFNLFlBQVk7QUFBQSxFQUNoQyxDQUFDO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
