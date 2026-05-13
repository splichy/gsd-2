import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModelRegistry } from "./model-registry.js";
function createRegistry() {
  const authStorage = {
    setFallbackResolver: () => {
    },
    onCredentialChange: () => {
    },
    getOAuthProviders: () => [],
    get: () => void 0,
    hasAuth: () => false,
    getApiKey: async () => void 0
  };
  return new ModelRegistry(authStorage, void 0);
}
describe("ModelRegistry authHeader wiring (#3874)", () => {
  it("adds Authorization bearer header for custom providers with authHeader enabled", () => {
    const registry = createRegistry();
    registry.registerProvider("bigmodel", {
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      api: "anthropic-messages",
      apiKey: "bigmodel-test-key",
      authHeader: true,
      models: [
        {
          id: "glm-5.1",
          name: "glm-5.1",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 2e5,
          maxTokens: 128e3
        }
      ]
    });
    const model = registry.getAll().find((m) => m.provider === "bigmodel" && m.id === "glm-5.1");
    assert.ok(model, "custom provider model should be registered");
    assert.equal(model.headers?.Authorization, "Bearer bigmodel-test-key");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL21vZGVsLXJlZ2lzdHJ5LWF1dGgtaGVhZGVyLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgZGVzY3JpYmUsIGl0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IHR5cGUgeyBBdXRoU3RvcmFnZSB9IGZyb20gXCIuL2F1dGgtc3RvcmFnZS5qc1wiO1xuaW1wb3J0IHsgTW9kZWxSZWdpc3RyeSB9IGZyb20gXCIuL21vZGVsLXJlZ2lzdHJ5LmpzXCI7XG5cbmZ1bmN0aW9uIGNyZWF0ZVJlZ2lzdHJ5KCk6IE1vZGVsUmVnaXN0cnkge1xuXHRjb25zdCBhdXRoU3RvcmFnZSA9IHtcblx0XHRzZXRGYWxsYmFja1Jlc29sdmVyOiAoKSA9PiB7fSxcblx0XHRvbkNyZWRlbnRpYWxDaGFuZ2U6ICgpID0+IHt9LFxuXHRcdGdldE9BdXRoUHJvdmlkZXJzOiAoKSA9PiBbXSxcblx0XHRnZXQ6ICgpID0+IHVuZGVmaW5lZCxcblx0XHRoYXNBdXRoOiAoKSA9PiBmYWxzZSxcblx0XHRnZXRBcGlLZXk6IGFzeW5jICgpID0+IHVuZGVmaW5lZCxcblx0fSBhcyB1bmtub3duIGFzIEF1dGhTdG9yYWdlO1xuXG5cdHJldHVybiBuZXcgTW9kZWxSZWdpc3RyeShhdXRoU3RvcmFnZSwgdW5kZWZpbmVkKTtcbn1cblxuZGVzY3JpYmUoXCJNb2RlbFJlZ2lzdHJ5IGF1dGhIZWFkZXIgd2lyaW5nICgjMzg3NClcIiwgKCkgPT4ge1xuXHRpdChcImFkZHMgQXV0aG9yaXphdGlvbiBiZWFyZXIgaGVhZGVyIGZvciBjdXN0b20gcHJvdmlkZXJzIHdpdGggYXV0aEhlYWRlciBlbmFibGVkXCIsICgpID0+IHtcblx0XHRjb25zdCByZWdpc3RyeSA9IGNyZWF0ZVJlZ2lzdHJ5KCk7XG5cdFx0cmVnaXN0cnkucmVnaXN0ZXJQcm92aWRlcihcImJpZ21vZGVsXCIsIHtcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVuLmJpZ21vZGVsLmNuL2FwaS9hbnRocm9waWNcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdGFwaUtleTogXCJiaWdtb2RlbC10ZXN0LWtleVwiLFxuXHRcdFx0YXV0aEhlYWRlcjogdHJ1ZSxcblx0XHRcdG1vZGVsczogW1xuXHRcdFx0XHR7XG5cdFx0XHRcdFx0aWQ6IFwiZ2xtLTUuMVwiLFxuXHRcdFx0XHRcdG5hbWU6IFwiZ2xtLTUuMVwiLFxuXHRcdFx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRcdFx0Y29zdDogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAgfSxcblx0XHRcdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0XHRcdH0sXG5cdFx0XHRdLFxuXHRcdH0pO1xuXG5cdFx0Y29uc3QgbW9kZWwgPSByZWdpc3RyeS5nZXRBbGwoKS5maW5kKChtKSA9PiBtLnByb3ZpZGVyID09PSBcImJpZ21vZGVsXCIgJiYgbS5pZCA9PT0gXCJnbG0tNS4xXCIpO1xuXHRcdGFzc2VydC5vayhtb2RlbCwgXCJjdXN0b20gcHJvdmlkZXIgbW9kZWwgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKG1vZGVsLmhlYWRlcnM/LkF1dGhvcml6YXRpb24sIFwiQmVhcmVyIGJpZ21vZGVsLXRlc3Qta2V5XCIpO1xuXHR9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxZQUFZO0FBQ25CLFNBQVMsVUFBVSxVQUFVO0FBRTdCLFNBQVMscUJBQXFCO0FBRTlCLFNBQVMsaUJBQWdDO0FBQ3hDLFFBQU0sY0FBYztBQUFBLElBQ25CLHFCQUFxQixNQUFNO0FBQUEsSUFBQztBQUFBLElBQzVCLG9CQUFvQixNQUFNO0FBQUEsSUFBQztBQUFBLElBQzNCLG1CQUFtQixNQUFNLENBQUM7QUFBQSxJQUMxQixLQUFLLE1BQU07QUFBQSxJQUNYLFNBQVMsTUFBTTtBQUFBLElBQ2YsV0FBVyxZQUFZO0FBQUEsRUFDeEI7QUFFQSxTQUFPLElBQUksY0FBYyxhQUFhLE1BQVM7QUFDaEQ7QUFFQSxTQUFTLDJDQUEyQyxNQUFNO0FBQ3pELEtBQUcsaUZBQWlGLE1BQU07QUFDekYsVUFBTSxXQUFXLGVBQWU7QUFDaEMsYUFBUyxpQkFBaUIsWUFBWTtBQUFBLE1BQ3JDLFNBQVM7QUFBQSxNQUNULEtBQUs7QUFBQSxNQUNMLFFBQVE7QUFBQSxNQUNSLFlBQVk7QUFBQSxNQUNaLFFBQVE7QUFBQSxRQUNQO0FBQUEsVUFDQyxJQUFJO0FBQUEsVUFDSixNQUFNO0FBQUEsVUFDTixXQUFXO0FBQUEsVUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLFVBQ2QsTUFBTSxFQUFFLE9BQU8sR0FBRyxRQUFRLEdBQUcsV0FBVyxHQUFHLFlBQVksRUFBRTtBQUFBLFVBQ3pELGVBQWU7QUFBQSxVQUNmLFdBQVc7QUFBQSxRQUNaO0FBQUEsTUFDRDtBQUFBLElBQ0QsQ0FBQztBQUVELFVBQU0sUUFBUSxTQUFTLE9BQU8sRUFBRSxLQUFLLENBQUMsTUFBTSxFQUFFLGFBQWEsY0FBYyxFQUFFLE9BQU8sU0FBUztBQUMzRixXQUFPLEdBQUcsT0FBTyw0Q0FBNEM7QUFDN0QsV0FBTyxNQUFNLE1BQU0sU0FBUyxlQUFlLDBCQUEwQjtBQUFBLEVBQ3RFLENBQUM7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
