import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelRegistry } from "../../packages/pi-coding-agent/src/core/model-registry.js";
function createAuthStorage() {
  return {
    setFallbackResolver: () => {
    },
    onCredentialChange: () => {
    },
    getOAuthProviders: () => [],
    get: () => void 0,
    hasAuth: () => false,
    getApiKey: async () => void 0
  };
}
test("parseModels registers custom providers in registeredProviders (#3531)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-model-registry-"));
  const modelsJsonPath = join(dir, "models.json");
  writeFileSync(
    modelsJsonPath,
    JSON.stringify({
      providers: {
        "custom-provider": {
          api: "openai-responses",
          baseUrl: "https://example.invalid/v1",
          apiKey: "test-key",
          models: [{ id: "custom-model" }]
        }
      }
    })
  );
  const registry = new ModelRegistry(createAuthStorage(), modelsJsonPath);
  assert.equal(registry.isProviderRequestReady("custom-provider"), true);
  assert.equal(registry.find("custom-provider", "custom-model")?.baseUrl, "https://example.invalid/v1");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL21vZGVsLXJlZ2lzdHJ5LWN1c3RvbS1wcm92aWRlci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlZ3Jlc3Npb24gdGVzdCBmb3IgIzM1MzE6IG1vZGVscy5qc29uIGN1c3RvbSBwcm92aWRlcnMgbXVzdCBiZSByZWdpc3RlcmVkXG4gKiBpbiByZWdpc3RlcmVkUHJvdmlkZXJzIHNvIGlzUHJvdmlkZXJSZXF1ZXN0UmVhZHkoKSByZXR1cm5zIHRydWUuXG4gKi9cbmltcG9ydCB7IHRlc3QgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgTW9kZWxSZWdpc3RyeSB9IGZyb20gXCIuLi8uLi9wYWNrYWdlcy9waS1jb2RpbmctYWdlbnQvc3JjL2NvcmUvbW9kZWwtcmVnaXN0cnkudHNcIjtcblxuZnVuY3Rpb24gY3JlYXRlQXV0aFN0b3JhZ2UoKTogYW55IHtcbiAgcmV0dXJuIHtcbiAgICBzZXRGYWxsYmFja1Jlc29sdmVyOiAoKSA9PiB7fSxcbiAgICBvbkNyZWRlbnRpYWxDaGFuZ2U6ICgpID0+IHt9LFxuICAgIGdldE9BdXRoUHJvdmlkZXJzOiAoKSA9PiBbXSxcbiAgICBnZXQ6ICgpID0+IHVuZGVmaW5lZCxcbiAgICBoYXNBdXRoOiAoKSA9PiBmYWxzZSxcbiAgICBnZXRBcGlLZXk6IGFzeW5jICgpID0+IHVuZGVmaW5lZCxcbiAgfTtcbn1cblxudGVzdChcInBhcnNlTW9kZWxzIHJlZ2lzdGVycyBjdXN0b20gcHJvdmlkZXJzIGluIHJlZ2lzdGVyZWRQcm92aWRlcnMgKCMzNTMxKVwiLCAoKSA9PiB7XG4gIGNvbnN0IGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLW1vZGVsLXJlZ2lzdHJ5LVwiKSk7XG4gIGNvbnN0IG1vZGVsc0pzb25QYXRoID0gam9pbihkaXIsIFwibW9kZWxzLmpzb25cIik7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgbW9kZWxzSnNvblBhdGgsXG4gICAgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgcHJvdmlkZXJzOiB7XG4gICAgICAgIFwiY3VzdG9tLXByb3ZpZGVyXCI6IHtcbiAgICAgICAgICBhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuICAgICAgICAgIGJhc2VVcmw6IFwiaHR0cHM6Ly9leGFtcGxlLmludmFsaWQvdjFcIixcbiAgICAgICAgICBhcGlLZXk6IFwidGVzdC1rZXlcIixcbiAgICAgICAgICBtb2RlbHM6IFt7IGlkOiBcImN1c3RvbS1tb2RlbFwiIH1dLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9KSxcbiAgKTtcblxuICBjb25zdCByZWdpc3RyeSA9IG5ldyBNb2RlbFJlZ2lzdHJ5KGNyZWF0ZUF1dGhTdG9yYWdlKCksIG1vZGVsc0pzb25QYXRoKTtcblxuICBhc3NlcnQuZXF1YWwocmVnaXN0cnkuaXNQcm92aWRlclJlcXVlc3RSZWFkeShcImN1c3RvbS1wcm92aWRlclwiKSwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChyZWdpc3RyeS5maW5kKFwiY3VzdG9tLXByb3ZpZGVyXCIsIFwiY3VzdG9tLW1vZGVsXCIpPy5iYXNlVXJsLCBcImh0dHBzOi8vZXhhbXBsZS5pbnZhbGlkL3YxXCIpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFJQSxTQUFTLFlBQVk7QUFDckIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxxQkFBcUI7QUFDM0MsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QixTQUFTLHFCQUFxQjtBQUU5QixTQUFTLG9CQUF5QjtBQUNoQyxTQUFPO0FBQUEsSUFDTCxxQkFBcUIsTUFBTTtBQUFBLElBQUM7QUFBQSxJQUM1QixvQkFBb0IsTUFBTTtBQUFBLElBQUM7QUFBQSxJQUMzQixtQkFBbUIsTUFBTSxDQUFDO0FBQUEsSUFDMUIsS0FBSyxNQUFNO0FBQUEsSUFDWCxTQUFTLE1BQU07QUFBQSxJQUNmLFdBQVcsWUFBWTtBQUFBLEVBQ3pCO0FBQ0Y7QUFFQSxLQUFLLHlFQUF5RSxNQUFNO0FBQ2xGLFFBQU0sTUFBTSxZQUFZLEtBQUssT0FBTyxHQUFHLHFCQUFxQixDQUFDO0FBQzdELFFBQU0saUJBQWlCLEtBQUssS0FBSyxhQUFhO0FBQzlDO0FBQUEsSUFDRTtBQUFBLElBQ0EsS0FBSyxVQUFVO0FBQUEsTUFDYixXQUFXO0FBQUEsUUFDVCxtQkFBbUI7QUFBQSxVQUNqQixLQUFLO0FBQUEsVUFDTCxTQUFTO0FBQUEsVUFDVCxRQUFRO0FBQUEsVUFDUixRQUFRLENBQUMsRUFBRSxJQUFJLGVBQWUsQ0FBQztBQUFBLFFBQ2pDO0FBQUEsTUFDRjtBQUFBLElBQ0YsQ0FBQztBQUFBLEVBQ0g7QUFFQSxRQUFNLFdBQVcsSUFBSSxjQUFjLGtCQUFrQixHQUFHLGNBQWM7QUFFdEUsU0FBTyxNQUFNLFNBQVMsdUJBQXVCLGlCQUFpQixHQUFHLElBQUk7QUFDckUsU0FBTyxNQUFNLFNBQVMsS0FBSyxtQkFBbUIsY0FBYyxHQUFHLFNBQVMsNEJBQTRCO0FBQ3RHLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
