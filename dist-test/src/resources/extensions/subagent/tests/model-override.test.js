import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSubagentProcessArgs } from "../index.js";
function makeAgent(overrides = {}) {
  return {
    name: "test-agent",
    description: "A test agent",
    systemPrompt: "You are a test agent",
    source: "project",
    filePath: "test-agent.md",
    tools: [],
    ...overrides
  };
}
describe("buildSubagentProcessArgs model override", () => {
  it("uses modelOverride when provided", () => {
    const agent = makeAgent({ model: "claude-haiku-4-5-20251001" });
    const args = buildSubagentProcessArgs(agent, "do something", null, "claude-sonnet-4-6");
    const modelIndex = args.indexOf("--model");
    assert.notEqual(modelIndex, -1, "should include --model flag");
    assert.equal(args[modelIndex + 1], "claude-sonnet-4-6");
  });
  it("falls back to agent.model when no override provided", () => {
    const agent = makeAgent({ model: "claude-haiku-4-5-20251001" });
    const args = buildSubagentProcessArgs(agent, "do something", null);
    const modelIndex = args.indexOf("--model");
    assert.notEqual(modelIndex, -1, "should include --model flag");
    assert.equal(args[modelIndex + 1], "claude-haiku-4-5-20251001");
  });
  it("omits --model when neither override nor agent.model is set", () => {
    const agent = makeAgent({ model: void 0 });
    const args = buildSubagentProcessArgs(agent, "do something", null);
    assert.equal(args.indexOf("--model"), -1, "should not include --model flag");
  });
  it("override takes precedence over agent.model", () => {
    const agent = makeAgent({ model: "model-a" });
    const args = buildSubagentProcessArgs(agent, "task", null, "model-b");
    const modelIndex = args.indexOf("--model");
    assert.equal(args[modelIndex + 1], "model-b");
  });
  it("uses override even when agent has no model", () => {
    const agent = makeAgent({ model: void 0 });
    const args = buildSubagentProcessArgs(agent, "task", null, "model-override");
    const modelIndex = args.indexOf("--model");
    assert.notEqual(modelIndex, -1);
    assert.equal(args[modelIndex + 1], "model-override");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3N1YmFnZW50L3Rlc3RzL21vZGVsLW92ZXJyaWRlLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGRlc2NyaWJlLCBpdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgYnVpbGRTdWJhZ2VudFByb2Nlc3NBcmdzIH0gZnJvbSBcIi4uL2luZGV4LmpzXCI7XG5pbXBvcnQgdHlwZSB7IEFnZW50Q29uZmlnIH0gZnJvbSBcIi4uL2FnZW50cy5qc1wiO1xuXG5mdW5jdGlvbiBtYWtlQWdlbnQob3ZlcnJpZGVzOiBQYXJ0aWFsPEFnZW50Q29uZmlnPiA9IHt9KTogQWdlbnRDb25maWcge1xuXHRyZXR1cm4ge1xuXHRcdG5hbWU6IFwidGVzdC1hZ2VudFwiLFxuXHRcdGRlc2NyaXB0aW9uOiBcIkEgdGVzdCBhZ2VudFwiLFxuXHRcdHN5c3RlbVByb21wdDogXCJZb3UgYXJlIGEgdGVzdCBhZ2VudFwiLFxuXHRcdHNvdXJjZTogXCJwcm9qZWN0XCIgYXMgY29uc3QsXG5cdFx0ZmlsZVBhdGg6IFwidGVzdC1hZ2VudC5tZFwiLFxuXHRcdHRvb2xzOiBbXSxcblx0XHQuLi5vdmVycmlkZXMsXG5cdH07XG59XG5cbmRlc2NyaWJlKFwiYnVpbGRTdWJhZ2VudFByb2Nlc3NBcmdzIG1vZGVsIG92ZXJyaWRlXCIsICgpID0+IHtcblx0aXQoXCJ1c2VzIG1vZGVsT3ZlcnJpZGUgd2hlbiBwcm92aWRlZFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgYWdlbnQgPSBtYWtlQWdlbnQoeyBtb2RlbDogXCJjbGF1ZGUtaGFpa3UtNC01LTIwMjUxMDAxXCIgfSk7XG5cdFx0Y29uc3QgYXJncyA9IGJ1aWxkU3ViYWdlbnRQcm9jZXNzQXJncyhhZ2VudCwgXCJkbyBzb21ldGhpbmdcIiwgbnVsbCwgXCJjbGF1ZGUtc29ubmV0LTQtNlwiKTtcblx0XHRjb25zdCBtb2RlbEluZGV4ID0gYXJncy5pbmRleE9mKFwiLS1tb2RlbFwiKTtcblx0XHRhc3NlcnQubm90RXF1YWwobW9kZWxJbmRleCwgLTEsIFwic2hvdWxkIGluY2x1ZGUgLS1tb2RlbCBmbGFnXCIpO1xuXHRcdGFzc2VydC5lcXVhbChhcmdzW21vZGVsSW5kZXggKyAxXSwgXCJjbGF1ZGUtc29ubmV0LTQtNlwiKTtcblx0fSk7XG5cblx0aXQoXCJmYWxscyBiYWNrIHRvIGFnZW50Lm1vZGVsIHdoZW4gbm8gb3ZlcnJpZGUgcHJvdmlkZWRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGFnZW50ID0gbWFrZUFnZW50KHsgbW9kZWw6IFwiY2xhdWRlLWhhaWt1LTQtNS0yMDI1MTAwMVwiIH0pO1xuXHRcdGNvbnN0IGFyZ3MgPSBidWlsZFN1YmFnZW50UHJvY2Vzc0FyZ3MoYWdlbnQsIFwiZG8gc29tZXRoaW5nXCIsIG51bGwpO1xuXHRcdGNvbnN0IG1vZGVsSW5kZXggPSBhcmdzLmluZGV4T2YoXCItLW1vZGVsXCIpO1xuXHRcdGFzc2VydC5ub3RFcXVhbChtb2RlbEluZGV4LCAtMSwgXCJzaG91bGQgaW5jbHVkZSAtLW1vZGVsIGZsYWdcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGFyZ3NbbW9kZWxJbmRleCArIDFdLCBcImNsYXVkZS1oYWlrdS00LTUtMjAyNTEwMDFcIik7XG5cdH0pO1xuXG5cdGl0KFwib21pdHMgLS1tb2RlbCB3aGVuIG5laXRoZXIgb3ZlcnJpZGUgbm9yIGFnZW50Lm1vZGVsIGlzIHNldFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgYWdlbnQgPSBtYWtlQWdlbnQoeyBtb2RlbDogdW5kZWZpbmVkIH0pO1xuXHRcdGNvbnN0IGFyZ3MgPSBidWlsZFN1YmFnZW50UHJvY2Vzc0FyZ3MoYWdlbnQsIFwiZG8gc29tZXRoaW5nXCIsIG51bGwpO1xuXHRcdGFzc2VydC5lcXVhbChhcmdzLmluZGV4T2YoXCItLW1vZGVsXCIpLCAtMSwgXCJzaG91bGQgbm90IGluY2x1ZGUgLS1tb2RlbCBmbGFnXCIpO1xuXHR9KTtcblxuXHRpdChcIm92ZXJyaWRlIHRha2VzIHByZWNlZGVuY2Ugb3ZlciBhZ2VudC5tb2RlbFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgYWdlbnQgPSBtYWtlQWdlbnQoeyBtb2RlbDogXCJtb2RlbC1hXCIgfSk7XG5cdFx0Y29uc3QgYXJncyA9IGJ1aWxkU3ViYWdlbnRQcm9jZXNzQXJncyhhZ2VudCwgXCJ0YXNrXCIsIG51bGwsIFwibW9kZWwtYlwiKTtcblx0XHRjb25zdCBtb2RlbEluZGV4ID0gYXJncy5pbmRleE9mKFwiLS1tb2RlbFwiKTtcblx0XHRhc3NlcnQuZXF1YWwoYXJnc1ttb2RlbEluZGV4ICsgMV0sIFwibW9kZWwtYlwiKTtcblx0fSk7XG5cblx0aXQoXCJ1c2VzIG92ZXJyaWRlIGV2ZW4gd2hlbiBhZ2VudCBoYXMgbm8gbW9kZWxcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGFnZW50ID0gbWFrZUFnZW50KHsgbW9kZWw6IHVuZGVmaW5lZCB9KTtcblx0XHRjb25zdCBhcmdzID0gYnVpbGRTdWJhZ2VudFByb2Nlc3NBcmdzKGFnZW50LCBcInRhc2tcIiwgbnVsbCwgXCJtb2RlbC1vdmVycmlkZVwiKTtcblx0XHRjb25zdCBtb2RlbEluZGV4ID0gYXJncy5pbmRleE9mKFwiLS1tb2RlbFwiKTtcblx0XHRhc3NlcnQubm90RXF1YWwobW9kZWxJbmRleCwgLTEpO1xuXHRcdGFzc2VydC5lcXVhbChhcmdzW21vZGVsSW5kZXggKyAxXSwgXCJtb2RlbC1vdmVycmlkZVwiKTtcblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsVUFBVSxVQUFVO0FBQzdCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGdDQUFnQztBQUd6QyxTQUFTLFVBQVUsWUFBa0MsQ0FBQyxHQUFnQjtBQUNyRSxTQUFPO0FBQUEsSUFDTixNQUFNO0FBQUEsSUFDTixhQUFhO0FBQUEsSUFDYixjQUFjO0FBQUEsSUFDZCxRQUFRO0FBQUEsSUFDUixVQUFVO0FBQUEsSUFDVixPQUFPLENBQUM7QUFBQSxJQUNSLEdBQUc7QUFBQSxFQUNKO0FBQ0Q7QUFFQSxTQUFTLDJDQUEyQyxNQUFNO0FBQ3pELEtBQUcsb0NBQW9DLE1BQU07QUFDNUMsVUFBTSxRQUFRLFVBQVUsRUFBRSxPQUFPLDRCQUE0QixDQUFDO0FBQzlELFVBQU0sT0FBTyx5QkFBeUIsT0FBTyxnQkFBZ0IsTUFBTSxtQkFBbUI7QUFDdEYsVUFBTSxhQUFhLEtBQUssUUFBUSxTQUFTO0FBQ3pDLFdBQU8sU0FBUyxZQUFZLElBQUksNkJBQTZCO0FBQzdELFdBQU8sTUFBTSxLQUFLLGFBQWEsQ0FBQyxHQUFHLG1CQUFtQjtBQUFBLEVBQ3ZELENBQUM7QUFFRCxLQUFHLHVEQUF1RCxNQUFNO0FBQy9ELFVBQU0sUUFBUSxVQUFVLEVBQUUsT0FBTyw0QkFBNEIsQ0FBQztBQUM5RCxVQUFNLE9BQU8seUJBQXlCLE9BQU8sZ0JBQWdCLElBQUk7QUFDakUsVUFBTSxhQUFhLEtBQUssUUFBUSxTQUFTO0FBQ3pDLFdBQU8sU0FBUyxZQUFZLElBQUksNkJBQTZCO0FBQzdELFdBQU8sTUFBTSxLQUFLLGFBQWEsQ0FBQyxHQUFHLDJCQUEyQjtBQUFBLEVBQy9ELENBQUM7QUFFRCxLQUFHLDhEQUE4RCxNQUFNO0FBQ3RFLFVBQU0sUUFBUSxVQUFVLEVBQUUsT0FBTyxPQUFVLENBQUM7QUFDNUMsVUFBTSxPQUFPLHlCQUF5QixPQUFPLGdCQUFnQixJQUFJO0FBQ2pFLFdBQU8sTUFBTSxLQUFLLFFBQVEsU0FBUyxHQUFHLElBQUksaUNBQWlDO0FBQUEsRUFDNUUsQ0FBQztBQUVELEtBQUcsOENBQThDLE1BQU07QUFDdEQsVUFBTSxRQUFRLFVBQVUsRUFBRSxPQUFPLFVBQVUsQ0FBQztBQUM1QyxVQUFNLE9BQU8seUJBQXlCLE9BQU8sUUFBUSxNQUFNLFNBQVM7QUFDcEUsVUFBTSxhQUFhLEtBQUssUUFBUSxTQUFTO0FBQ3pDLFdBQU8sTUFBTSxLQUFLLGFBQWEsQ0FBQyxHQUFHLFNBQVM7QUFBQSxFQUM3QyxDQUFDO0FBRUQsS0FBRyw4Q0FBOEMsTUFBTTtBQUN0RCxVQUFNLFFBQVEsVUFBVSxFQUFFLE9BQU8sT0FBVSxDQUFDO0FBQzVDLFVBQU0sT0FBTyx5QkFBeUIsT0FBTyxRQUFRLE1BQU0sZ0JBQWdCO0FBQzNFLFVBQU0sYUFBYSxLQUFLLFFBQVEsU0FBUztBQUN6QyxXQUFPLFNBQVMsWUFBWSxFQUFFO0FBQzlCLFdBQU8sTUFBTSxLQUFLLGFBQWEsQ0FBQyxHQUFHLGdCQUFnQjtBQUFBLEVBQ3BELENBQUM7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
