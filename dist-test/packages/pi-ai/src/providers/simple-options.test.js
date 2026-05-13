import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildBaseOptions, defaultMaxTokens } from "./simple-options.js";
function makeModel(overrides = {}) {
  return {
    id: "test-model",
    name: "Test Model",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16384,
    maxTokens: 16384,
    ...overrides
  };
}
describe("defaultMaxTokens", () => {
  test("leaves prompt room when a non-Anthropic model declares output equal to context", () => {
    const model = makeModel({
      id: "qwen.qwen3-32b-v1:0",
      contextWindow: 16384,
      maxTokens: 16384
    });
    assert.equal(defaultMaxTokens(model), 8192);
  });
  test("preserves smaller declared output windows", () => {
    const model = makeModel({
      contextWindow: 32e3,
      maxTokens: 8192
    });
    assert.equal(defaultMaxTokens(model), 8192);
  });
  test("keeps the native Anthropic 32k ceiling within the context cap", () => {
    const model = makeModel({
      api: "anthropic-messages",
      provider: "anthropic",
      contextWindow: 2e5,
      maxTokens: 64e3
    });
    assert.equal(defaultMaxTokens(model), 32e3);
  });
  test("honors explicit maxTokens", () => {
    const model = makeModel();
    const options = buildBaseOptions(model, { maxTokens: 12e3 });
    assert.equal(options.maxTokens, 12e3);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL3Byb3ZpZGVycy9zaW1wbGUtb3B0aW9ucy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuXG5pbXBvcnQgeyBidWlsZEJhc2VPcHRpb25zLCBkZWZhdWx0TWF4VG9rZW5zIH0gZnJvbSBcIi4vc2ltcGxlLW9wdGlvbnMuanNcIjtcbmltcG9ydCB0eXBlIHsgQXBpLCBNb2RlbCB9IGZyb20gXCIuLi90eXBlcy5qc1wiO1xuXG5mdW5jdGlvbiBtYWtlTW9kZWwob3ZlcnJpZGVzOiBQYXJ0aWFsPE1vZGVsPEFwaT4+ID0ge30pOiBNb2RlbDxBcGk+IHtcblx0cmV0dXJuIHtcblx0XHRpZDogXCJ0ZXN0LW1vZGVsXCIsXG5cdFx0bmFtZTogXCJUZXN0IE1vZGVsXCIsXG5cdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRiYXNlVXJsOiBcIlwiLFxuXHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0Y29zdDogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAgfSxcblx0XHRjb250ZXh0V2luZG93OiAxNjM4NCxcblx0XHRtYXhUb2tlbnM6IDE2Mzg0LFxuXHRcdC4uLm92ZXJyaWRlcyxcblx0fTtcbn1cblxuZGVzY3JpYmUoXCJkZWZhdWx0TWF4VG9rZW5zXCIsICgpID0+IHtcblx0dGVzdChcImxlYXZlcyBwcm9tcHQgcm9vbSB3aGVuIGEgbm9uLUFudGhyb3BpYyBtb2RlbCBkZWNsYXJlcyBvdXRwdXQgZXF1YWwgdG8gY29udGV4dFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbW9kZWwgPSBtYWtlTW9kZWwoe1xuXHRcdFx0aWQ6IFwicXdlbi5xd2VuMy0zMmItdjE6MFwiLFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTYzODQsXG5cdFx0XHRtYXhUb2tlbnM6IDE2Mzg0LFxuXHRcdH0pO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKGRlZmF1bHRNYXhUb2tlbnMobW9kZWwpLCA4MTkyKTtcblx0fSk7XG5cblx0dGVzdChcInByZXNlcnZlcyBzbWFsbGVyIGRlY2xhcmVkIG91dHB1dCB3aW5kb3dzXCIsICgpID0+IHtcblx0XHRjb25zdCBtb2RlbCA9IG1ha2VNb2RlbCh7XG5cdFx0XHRjb250ZXh0V2luZG93OiAzMjAwMCxcblx0XHRcdG1heFRva2VuczogODE5Mixcblx0XHR9KTtcblxuXHRcdGFzc2VydC5lcXVhbChkZWZhdWx0TWF4VG9rZW5zKG1vZGVsKSwgODE5Mik7XG5cdH0pO1xuXG5cdHRlc3QoXCJrZWVwcyB0aGUgbmF0aXZlIEFudGhyb3BpYyAzMmsgY2VpbGluZyB3aXRoaW4gdGhlIGNvbnRleHQgY2FwXCIsICgpID0+IHtcblx0XHRjb25zdCBtb2RlbCA9IG1ha2VNb2RlbCh7XG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbnRocm9waWNcIixcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogNjQwMDAsXG5cdFx0fSk7XG5cblx0XHRhc3NlcnQuZXF1YWwoZGVmYXVsdE1heFRva2Vucyhtb2RlbCksIDMyMDAwKTtcblx0fSk7XG5cblx0dGVzdChcImhvbm9ycyBleHBsaWNpdCBtYXhUb2tlbnNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG1vZGVsID0gbWFrZU1vZGVsKCk7XG5cdFx0Y29uc3Qgb3B0aW9ucyA9IGJ1aWxkQmFzZU9wdGlvbnMobW9kZWwsIHsgbWF4VG9rZW5zOiAxMjAwMCB9KTtcblxuXHRcdGFzc2VydC5lcXVhbChvcHRpb25zLm1heFRva2VucywgMTIwMDApO1xuXHR9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLFlBQVk7QUFDL0IsT0FBTyxZQUFZO0FBRW5CLFNBQVMsa0JBQWtCLHdCQUF3QjtBQUduRCxTQUFTLFVBQVUsWUFBaUMsQ0FBQyxHQUFlO0FBQ25FLFNBQU87QUFBQSxJQUNOLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNLEVBQUUsT0FBTyxHQUFHLFFBQVEsR0FBRyxXQUFXLEdBQUcsWUFBWSxFQUFFO0FBQUEsSUFDekQsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLElBQ1gsR0FBRztBQUFBLEVBQ0o7QUFDRDtBQUVBLFNBQVMsb0JBQW9CLE1BQU07QUFDbEMsT0FBSyxrRkFBa0YsTUFBTTtBQUM1RixVQUFNLFFBQVEsVUFBVTtBQUFBLE1BQ3ZCLElBQUk7QUFBQSxNQUNKLGVBQWU7QUFBQSxNQUNmLFdBQVc7QUFBQSxJQUNaLENBQUM7QUFFRCxXQUFPLE1BQU0saUJBQWlCLEtBQUssR0FBRyxJQUFJO0FBQUEsRUFDM0MsQ0FBQztBQUVELE9BQUssNkNBQTZDLE1BQU07QUFDdkQsVUFBTSxRQUFRLFVBQVU7QUFBQSxNQUN2QixlQUFlO0FBQUEsTUFDZixXQUFXO0FBQUEsSUFDWixDQUFDO0FBRUQsV0FBTyxNQUFNLGlCQUFpQixLQUFLLEdBQUcsSUFBSTtBQUFBLEVBQzNDLENBQUM7QUFFRCxPQUFLLGlFQUFpRSxNQUFNO0FBQzNFLFVBQU0sUUFBUSxVQUFVO0FBQUEsTUFDdkIsS0FBSztBQUFBLE1BQ0wsVUFBVTtBQUFBLE1BQ1YsZUFBZTtBQUFBLE1BQ2YsV0FBVztBQUFBLElBQ1osQ0FBQztBQUVELFdBQU8sTUFBTSxpQkFBaUIsS0FBSyxHQUFHLElBQUs7QUFBQSxFQUM1QyxDQUFDO0FBRUQsT0FBSyw2QkFBNkIsTUFBTTtBQUN2QyxVQUFNLFFBQVEsVUFBVTtBQUN4QixVQUFNLFVBQVUsaUJBQWlCLE9BQU8sRUFBRSxXQUFXLEtBQU0sQ0FBQztBQUU1RCxXQUFPLE1BQU0sUUFBUSxXQUFXLElBQUs7QUFBQSxFQUN0QyxDQUFDO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
