import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModelRegistry } from "./model-registry.js";
function createRegistryWithCapturedResolver() {
  let capturedResolver;
  const authStorage = {
    setFallbackResolver: (resolver) => {
      capturedResolver = resolver;
    },
    onCredentialChange: () => {
    },
    getOAuthProviders: () => [],
    get: () => void 0,
    hasAuth: () => false,
    getApiKey: async () => void 0
  };
  new ModelRegistry(authStorage, void 0);
  assert.ok(capturedResolver, "ModelRegistry should register a fallback resolver");
  return capturedResolver;
}
describe("ModelRegistry env fallback resolver (#3782)", () => {
  it("falls back to built-in provider env vars when models.json has no custom key", () => {
    const prev = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = "minimax-env-test-key";
    try {
      const resolver = createRegistryWithCapturedResolver();
      assert.equal(
        resolver("minimax"),
        "minimax-env-test-key",
        "fallback resolver should return built-in provider env keys"
      );
    } finally {
      if (prev === void 0) {
        delete process.env.MINIMAX_API_KEY;
      } else {
        process.env.MINIMAX_API_KEY = prev;
      }
    }
  });
  it("still returns undefined when no custom or built-in env key exists", () => {
    const prev = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    try {
      const resolver = createRegistryWithCapturedResolver();
      assert.equal(resolver("minimax"), void 0);
      assert.equal(resolver("totally-unknown-provider"), void 0);
    } finally {
      if (prev !== void 0) {
        process.env.MINIMAX_API_KEY = prev;
      }
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL21vZGVsLXJlZ2lzdHJ5LWVudi1mYWxsYmFjay50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGRlc2NyaWJlLCBpdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCB0eXBlIHsgQXV0aFN0b3JhZ2UgfSBmcm9tIFwiLi9hdXRoLXN0b3JhZ2UuanNcIjtcbmltcG9ydCB7IE1vZGVsUmVnaXN0cnkgfSBmcm9tIFwiLi9tb2RlbC1yZWdpc3RyeS5qc1wiO1xuXG5mdW5jdGlvbiBjcmVhdGVSZWdpc3RyeVdpdGhDYXB0dXJlZFJlc29sdmVyKCkge1xuXHRsZXQgY2FwdHVyZWRSZXNvbHZlcjogKChwcm92aWRlcjogc3RyaW5nKSA9PiBzdHJpbmcgfCB1bmRlZmluZWQpIHwgdW5kZWZpbmVkO1xuXHRjb25zdCBhdXRoU3RvcmFnZSA9IHtcblx0XHRzZXRGYWxsYmFja1Jlc29sdmVyOiAocmVzb2x2ZXI6IChwcm92aWRlcjogc3RyaW5nKSA9PiBzdHJpbmcgfCB1bmRlZmluZWQpID0+IHtcblx0XHRcdGNhcHR1cmVkUmVzb2x2ZXIgPSByZXNvbHZlcjtcblx0XHR9LFxuXHRcdG9uQ3JlZGVudGlhbENoYW5nZTogKCkgPT4ge30sXG5cdFx0Z2V0T0F1dGhQcm92aWRlcnM6ICgpID0+IFtdLFxuXHRcdGdldDogKCkgPT4gdW5kZWZpbmVkLFxuXHRcdGhhc0F1dGg6ICgpID0+IGZhbHNlLFxuXHRcdGdldEFwaUtleTogYXN5bmMgKCkgPT4gdW5kZWZpbmVkLFxuXHR9IGFzIHVua25vd24gYXMgQXV0aFN0b3JhZ2U7XG5cblx0bmV3IE1vZGVsUmVnaXN0cnkoYXV0aFN0b3JhZ2UsIHVuZGVmaW5lZCk7XG5cdGFzc2VydC5vayhjYXB0dXJlZFJlc29sdmVyLCBcIk1vZGVsUmVnaXN0cnkgc2hvdWxkIHJlZ2lzdGVyIGEgZmFsbGJhY2sgcmVzb2x2ZXJcIik7XG5cdHJldHVybiBjYXB0dXJlZFJlc29sdmVyITtcbn1cblxuZGVzY3JpYmUoXCJNb2RlbFJlZ2lzdHJ5IGVudiBmYWxsYmFjayByZXNvbHZlciAoIzM3ODIpXCIsICgpID0+IHtcblx0aXQoXCJmYWxscyBiYWNrIHRvIGJ1aWx0LWluIHByb3ZpZGVyIGVudiB2YXJzIHdoZW4gbW9kZWxzLmpzb24gaGFzIG5vIGN1c3RvbSBrZXlcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHByZXYgPSBwcm9jZXNzLmVudi5NSU5JTUFYX0FQSV9LRVk7XG5cdFx0cHJvY2Vzcy5lbnYuTUlOSU1BWF9BUElfS0VZID0gXCJtaW5pbWF4LWVudi10ZXN0LWtleVwiO1xuXG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IHJlc29sdmVyID0gY3JlYXRlUmVnaXN0cnlXaXRoQ2FwdHVyZWRSZXNvbHZlcigpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0XHRyZXNvbHZlcihcIm1pbmltYXhcIiksXG5cdFx0XHRcdFwibWluaW1heC1lbnYtdGVzdC1rZXlcIixcblx0XHRcdFx0XCJmYWxsYmFjayByZXNvbHZlciBzaG91bGQgcmV0dXJuIGJ1aWx0LWluIHByb3ZpZGVyIGVudiBrZXlzXCIsXG5cdFx0XHQpO1xuXHRcdH0gZmluYWxseSB7XG5cdFx0XHRpZiAocHJldiA9PT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdGRlbGV0ZSBwcm9jZXNzLmVudi5NSU5JTUFYX0FQSV9LRVk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRwcm9jZXNzLmVudi5NSU5JTUFYX0FQSV9LRVkgPSBwcmV2O1xuXHRcdFx0fVxuXHRcdH1cblx0fSk7XG5cblx0aXQoXCJzdGlsbCByZXR1cm5zIHVuZGVmaW5lZCB3aGVuIG5vIGN1c3RvbSBvciBidWlsdC1pbiBlbnYga2V5IGV4aXN0c1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcHJldiA9IHByb2Nlc3MuZW52Lk1JTklNQVhfQVBJX0tFWTtcblx0XHRkZWxldGUgcHJvY2Vzcy5lbnYuTUlOSU1BWF9BUElfS0VZO1xuXG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IHJlc29sdmVyID0gY3JlYXRlUmVnaXN0cnlXaXRoQ2FwdHVyZWRSZXNvbHZlcigpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHJlc29sdmVyKFwibWluaW1heFwiKSwgdW5kZWZpbmVkKTtcblx0XHRcdGFzc2VydC5lcXVhbChyZXNvbHZlcihcInRvdGFsbHktdW5rbm93bi1wcm92aWRlclwiKSwgdW5kZWZpbmVkKTtcblx0XHR9IGZpbmFsbHkge1xuXHRcdFx0aWYgKHByZXYgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRwcm9jZXNzLmVudi5NSU5JTUFYX0FQSV9LRVkgPSBwcmV2O1xuXHRcdFx0fVxuXHRcdH1cblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sWUFBWTtBQUNuQixTQUFTLFVBQVUsVUFBVTtBQUU3QixTQUFTLHFCQUFxQjtBQUU5QixTQUFTLHFDQUFxQztBQUM3QyxNQUFJO0FBQ0osUUFBTSxjQUFjO0FBQUEsSUFDbkIscUJBQXFCLENBQUMsYUFBdUQ7QUFDNUUseUJBQW1CO0FBQUEsSUFDcEI7QUFBQSxJQUNBLG9CQUFvQixNQUFNO0FBQUEsSUFBQztBQUFBLElBQzNCLG1CQUFtQixNQUFNLENBQUM7QUFBQSxJQUMxQixLQUFLLE1BQU07QUFBQSxJQUNYLFNBQVMsTUFBTTtBQUFBLElBQ2YsV0FBVyxZQUFZO0FBQUEsRUFDeEI7QUFFQSxNQUFJLGNBQWMsYUFBYSxNQUFTO0FBQ3hDLFNBQU8sR0FBRyxrQkFBa0IsbURBQW1EO0FBQy9FLFNBQU87QUFDUjtBQUVBLFNBQVMsK0NBQStDLE1BQU07QUFDN0QsS0FBRywrRUFBK0UsTUFBTTtBQUN2RixVQUFNLE9BQU8sUUFBUSxJQUFJO0FBQ3pCLFlBQVEsSUFBSSxrQkFBa0I7QUFFOUIsUUFBSTtBQUNILFlBQU0sV0FBVyxtQ0FBbUM7QUFDcEQsYUFBTztBQUFBLFFBQ04sU0FBUyxTQUFTO0FBQUEsUUFDbEI7QUFBQSxRQUNBO0FBQUEsTUFDRDtBQUFBLElBQ0QsVUFBRTtBQUNELFVBQUksU0FBUyxRQUFXO0FBQ3ZCLGVBQU8sUUFBUSxJQUFJO0FBQUEsTUFDcEIsT0FBTztBQUNOLGdCQUFRLElBQUksa0JBQWtCO0FBQUEsTUFDL0I7QUFBQSxJQUNEO0FBQUEsRUFDRCxDQUFDO0FBRUQsS0FBRyxxRUFBcUUsTUFBTTtBQUM3RSxVQUFNLE9BQU8sUUFBUSxJQUFJO0FBQ3pCLFdBQU8sUUFBUSxJQUFJO0FBRW5CLFFBQUk7QUFDSCxZQUFNLFdBQVcsbUNBQW1DO0FBQ3BELGFBQU8sTUFBTSxTQUFTLFNBQVMsR0FBRyxNQUFTO0FBQzNDLGFBQU8sTUFBTSxTQUFTLDBCQUEwQixHQUFHLE1BQVM7QUFBQSxJQUM3RCxVQUFFO0FBQ0QsVUFBSSxTQUFTLFFBQVc7QUFDdkIsZ0JBQVEsSUFBSSxrQkFBa0I7QUFBQSxNQUMvQjtBQUFBLElBQ0Q7QUFBQSxFQUNELENBQUM7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
