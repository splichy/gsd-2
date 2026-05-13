import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findInitialModel } from "./model-resolver.js";
function makeModel(provider, id) {
  return {
    id,
    name: id,
    provider,
    api: "openai-responses",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128e3,
    maxTokens: 8192
  };
}
function makeRegistry(opts) {
  const readyProviders = opts.readyProviders ?? /* @__PURE__ */ new Set();
  const byProviderAndId = opts.byProviderAndId ?? /* @__PURE__ */ new Map();
  const available = opts.available ?? [];
  return {
    find: (provider, modelId) => byProviderAndId.get(`${provider}/${modelId}`),
    getAvailable: async () => available,
    isProviderRequestReady: (provider) => readyProviders.has(provider)
  };
}
describe("findInitialModel auth gating for saved defaults", () => {
  it("uses saved default when provider is request-ready", async () => {
    const saved = makeModel("anthropic", "claude-opus-4-6");
    const registry = makeRegistry({
      readyProviders: /* @__PURE__ */ new Set(["anthropic"]),
      byProviderAndId: /* @__PURE__ */ new Map([[`anthropic/claude-opus-4-6`, saved]]),
      available: [saved]
    });
    const result = await findInitialModel({
      scopedModels: [],
      isContinuing: false,
      defaultProvider: "anthropic",
      defaultModelId: "claude-opus-4-6",
      modelRegistry: registry
    });
    assert.equal(result.model?.provider, "anthropic");
    assert.equal(result.model?.id, "claude-opus-4-6");
  });
  it("skips saved default when provider is not request-ready and falls back to available", async () => {
    const staleDefault = makeModel("anthropic", "claude-opus-4-6");
    const fallback = makeModel("openai", "gpt-5.4");
    const registry = makeRegistry({
      readyProviders: /* @__PURE__ */ new Set(["openai"]),
      byProviderAndId: /* @__PURE__ */ new Map([[`anthropic/claude-opus-4-6`, staleDefault]]),
      available: [fallback]
    });
    const result = await findInitialModel({
      scopedModels: [],
      isContinuing: false,
      defaultProvider: "anthropic",
      defaultModelId: "claude-opus-4-6",
      modelRegistry: registry
    });
    assert.equal(result.model?.provider, "openai");
    assert.equal(result.model?.id, "gpt-5.4");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL21vZGVsLXJlc29sdmVyLWluaXRpYWwtbW9kZWwtYXV0aC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGRlc2NyaWJlLCBpdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCB0eXBlIHsgQXBpLCBNb2RlbCB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgdHlwZSB7IE1vZGVsUmVnaXN0cnkgfSBmcm9tIFwiLi9tb2RlbC1yZWdpc3RyeS5qc1wiO1xuaW1wb3J0IHsgZmluZEluaXRpYWxNb2RlbCB9IGZyb20gXCIuL21vZGVsLXJlc29sdmVyLmpzXCI7XG5cbmZ1bmN0aW9uIG1ha2VNb2RlbChwcm92aWRlcjogc3RyaW5nLCBpZDogc3RyaW5nKTogTW9kZWw8QXBpPiB7XG4gIHJldHVybiB7XG4gICAgaWQsXG4gICAgbmFtZTogaWQsXG4gICAgcHJvdmlkZXIsXG4gICAgYXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcbiAgICByZWFzb25pbmc6IGZhbHNlLFxuICAgIGlucHV0OiBbXCJ0ZXh0XCJdLFxuICAgIGNvc3Q6IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwIH0sXG4gICAgY29udGV4dFdpbmRvdzogMTI4MDAwLFxuICAgIG1heFRva2VuczogODE5MixcbiAgfSBhcyBNb2RlbDxBcGk+O1xufVxuXG5mdW5jdGlvbiBtYWtlUmVnaXN0cnkob3B0czoge1xuICByZWFkeVByb3ZpZGVycz86IFNldDxzdHJpbmc+O1xuICBieVByb3ZpZGVyQW5kSWQ/OiBNYXA8c3RyaW5nLCBNb2RlbDxBcGk+PjtcbiAgYXZhaWxhYmxlPzogTW9kZWw8QXBpPltdO1xufSk6IE1vZGVsUmVnaXN0cnkge1xuICBjb25zdCByZWFkeVByb3ZpZGVycyA9IG9wdHMucmVhZHlQcm92aWRlcnMgPz8gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGJ5UHJvdmlkZXJBbmRJZCA9IG9wdHMuYnlQcm92aWRlckFuZElkID8/IG5ldyBNYXA8c3RyaW5nLCBNb2RlbDxBcGk+PigpO1xuICBjb25zdCBhdmFpbGFibGUgPSBvcHRzLmF2YWlsYWJsZSA/PyBbXTtcblxuICByZXR1cm4ge1xuICAgIGZpbmQ6IChwcm92aWRlcjogc3RyaW5nLCBtb2RlbElkOiBzdHJpbmcpID0+IGJ5UHJvdmlkZXJBbmRJZC5nZXQoYCR7cHJvdmlkZXJ9LyR7bW9kZWxJZH1gKSxcbiAgICBnZXRBdmFpbGFibGU6IGFzeW5jICgpID0+IGF2YWlsYWJsZSxcbiAgICBpc1Byb3ZpZGVyUmVxdWVzdFJlYWR5OiAocHJvdmlkZXI6IHN0cmluZykgPT4gcmVhZHlQcm92aWRlcnMuaGFzKHByb3ZpZGVyKSxcbiAgfSBhcyB1bmtub3duIGFzIE1vZGVsUmVnaXN0cnk7XG59XG5cbmRlc2NyaWJlKFwiZmluZEluaXRpYWxNb2RlbCBhdXRoIGdhdGluZyBmb3Igc2F2ZWQgZGVmYXVsdHNcIiwgKCkgPT4ge1xuICBpdChcInVzZXMgc2F2ZWQgZGVmYXVsdCB3aGVuIHByb3ZpZGVyIGlzIHJlcXVlc3QtcmVhZHlcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHNhdmVkID0gbWFrZU1vZGVsKFwiYW50aHJvcGljXCIsIFwiY2xhdWRlLW9wdXMtNC02XCIpO1xuICAgIGNvbnN0IHJlZ2lzdHJ5ID0gbWFrZVJlZ2lzdHJ5KHtcbiAgICAgIHJlYWR5UHJvdmlkZXJzOiBuZXcgU2V0KFtcImFudGhyb3BpY1wiXSksXG4gICAgICBieVByb3ZpZGVyQW5kSWQ6IG5ldyBNYXAoW1tgYW50aHJvcGljL2NsYXVkZS1vcHVzLTQtNmAsIHNhdmVkXV0pLFxuICAgICAgYXZhaWxhYmxlOiBbc2F2ZWRdLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZmluZEluaXRpYWxNb2RlbCh7XG4gICAgICBzY29wZWRNb2RlbHM6IFtdLFxuICAgICAgaXNDb250aW51aW5nOiBmYWxzZSxcbiAgICAgIGRlZmF1bHRQcm92aWRlcjogXCJhbnRocm9waWNcIixcbiAgICAgIGRlZmF1bHRNb2RlbElkOiBcImNsYXVkZS1vcHVzLTQtNlwiLFxuICAgICAgbW9kZWxSZWdpc3RyeTogcmVnaXN0cnksXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1vZGVsPy5wcm92aWRlciwgXCJhbnRocm9waWNcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tb2RlbD8uaWQsIFwiY2xhdWRlLW9wdXMtNC02XCIpO1xuICB9KTtcblxuICBpdChcInNraXBzIHNhdmVkIGRlZmF1bHQgd2hlbiBwcm92aWRlciBpcyBub3QgcmVxdWVzdC1yZWFkeSBhbmQgZmFsbHMgYmFjayB0byBhdmFpbGFibGVcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHN0YWxlRGVmYXVsdCA9IG1ha2VNb2RlbChcImFudGhyb3BpY1wiLCBcImNsYXVkZS1vcHVzLTQtNlwiKTtcbiAgICBjb25zdCBmYWxsYmFjayA9IG1ha2VNb2RlbChcIm9wZW5haVwiLCBcImdwdC01LjRcIik7XG4gICAgY29uc3QgcmVnaXN0cnkgPSBtYWtlUmVnaXN0cnkoe1xuICAgICAgcmVhZHlQcm92aWRlcnM6IG5ldyBTZXQoW1wib3BlbmFpXCJdKSxcbiAgICAgIGJ5UHJvdmlkZXJBbmRJZDogbmV3IE1hcChbW2BhbnRocm9waWMvY2xhdWRlLW9wdXMtNC02YCwgc3RhbGVEZWZhdWx0XV0pLFxuICAgICAgYXZhaWxhYmxlOiBbZmFsbGJhY2tdLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZmluZEluaXRpYWxNb2RlbCh7XG4gICAgICBzY29wZWRNb2RlbHM6IFtdLFxuICAgICAgaXNDb250aW51aW5nOiBmYWxzZSxcbiAgICAgIGRlZmF1bHRQcm92aWRlcjogXCJhbnRocm9waWNcIixcbiAgICAgIGRlZmF1bHRNb2RlbElkOiBcImNsYXVkZS1vcHVzLTQtNlwiLFxuICAgICAgbW9kZWxSZWdpc3RyeTogcmVnaXN0cnksXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1vZGVsPy5wcm92aWRlciwgXCJvcGVuYWlcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tb2RlbD8uaWQsIFwiZ3B0LTUuNFwiKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sWUFBWTtBQUNuQixTQUFTLFVBQVUsVUFBVTtBQUc3QixTQUFTLHdCQUF3QjtBQUVqQyxTQUFTLFVBQVUsVUFBa0IsSUFBd0I7QUFDM0QsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBLE1BQU07QUFBQSxJQUNOO0FBQUEsSUFDQSxLQUFLO0FBQUEsSUFDTCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTSxFQUFFLE9BQU8sR0FBRyxRQUFRLEdBQUcsV0FBVyxHQUFHLFlBQVksRUFBRTtBQUFBLElBQ3pELGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNiO0FBQ0Y7QUFFQSxTQUFTLGFBQWEsTUFJSjtBQUNoQixRQUFNLGlCQUFpQixLQUFLLGtCQUFrQixvQkFBSSxJQUFZO0FBQzlELFFBQU0sa0JBQWtCLEtBQUssbUJBQW1CLG9CQUFJLElBQXdCO0FBQzVFLFFBQU0sWUFBWSxLQUFLLGFBQWEsQ0FBQztBQUVyQyxTQUFPO0FBQUEsSUFDTCxNQUFNLENBQUMsVUFBa0IsWUFBb0IsZ0JBQWdCLElBQUksR0FBRyxRQUFRLElBQUksT0FBTyxFQUFFO0FBQUEsSUFDekYsY0FBYyxZQUFZO0FBQUEsSUFDMUIsd0JBQXdCLENBQUMsYUFBcUIsZUFBZSxJQUFJLFFBQVE7QUFBQSxFQUMzRTtBQUNGO0FBRUEsU0FBUyxtREFBbUQsTUFBTTtBQUNoRSxLQUFHLHFEQUFxRCxZQUFZO0FBQ2xFLFVBQU0sUUFBUSxVQUFVLGFBQWEsaUJBQWlCO0FBQ3RELFVBQU0sV0FBVyxhQUFhO0FBQUEsTUFDNUIsZ0JBQWdCLG9CQUFJLElBQUksQ0FBQyxXQUFXLENBQUM7QUFBQSxNQUNyQyxpQkFBaUIsb0JBQUksSUFBSSxDQUFDLENBQUMsNkJBQTZCLEtBQUssQ0FBQyxDQUFDO0FBQUEsTUFDL0QsV0FBVyxDQUFDLEtBQUs7QUFBQSxJQUNuQixDQUFDO0FBRUQsVUFBTSxTQUFTLE1BQU0saUJBQWlCO0FBQUEsTUFDcEMsY0FBYyxDQUFDO0FBQUEsTUFDZixjQUFjO0FBQUEsTUFDZCxpQkFBaUI7QUFBQSxNQUNqQixnQkFBZ0I7QUFBQSxNQUNoQixlQUFlO0FBQUEsSUFDakIsQ0FBQztBQUVELFdBQU8sTUFBTSxPQUFPLE9BQU8sVUFBVSxXQUFXO0FBQ2hELFdBQU8sTUFBTSxPQUFPLE9BQU8sSUFBSSxpQkFBaUI7QUFBQSxFQUNsRCxDQUFDO0FBRUQsS0FBRyxzRkFBc0YsWUFBWTtBQUNuRyxVQUFNLGVBQWUsVUFBVSxhQUFhLGlCQUFpQjtBQUM3RCxVQUFNLFdBQVcsVUFBVSxVQUFVLFNBQVM7QUFDOUMsVUFBTSxXQUFXLGFBQWE7QUFBQSxNQUM1QixnQkFBZ0Isb0JBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQztBQUFBLE1BQ2xDLGlCQUFpQixvQkFBSSxJQUFJLENBQUMsQ0FBQyw2QkFBNkIsWUFBWSxDQUFDLENBQUM7QUFBQSxNQUN0RSxXQUFXLENBQUMsUUFBUTtBQUFBLElBQ3RCLENBQUM7QUFFRCxVQUFNLFNBQVMsTUFBTSxpQkFBaUI7QUFBQSxNQUNwQyxjQUFjLENBQUM7QUFBQSxNQUNmLGNBQWM7QUFBQSxNQUNkLGlCQUFpQjtBQUFBLE1BQ2pCLGdCQUFnQjtBQUFBLE1BQ2hCLGVBQWU7QUFBQSxJQUNqQixDQUFDO0FBRUQsV0FBTyxNQUFNLE9BQU8sT0FBTyxVQUFVLFFBQVE7QUFDN0MsV0FBTyxNQUFNLE9BQU8sT0FBTyxJQUFJLFNBQVM7QUFBQSxFQUMxQyxDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
