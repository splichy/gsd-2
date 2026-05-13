import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { convertTools, mapStopReason, mapThinkingLevelToEffort } from "./anthropic-shared.js";
const makeTool = (name) => ({
  name,
  description: `desc for ${name}`,
  parameters: {
    type: "object",
    properties: { arg: { type: "string" } },
    required: ["arg"]
  }
});
describe("convertTools cache_control", () => {
  it("adds cache_control to the last tool when cacheControl is provided", () => {
    const tools = [makeTool("Read"), makeTool("Write"), makeTool("Edit")];
    const cacheControl = { type: "ephemeral" };
    const result = convertTools(tools, false, cacheControl);
    assert.equal(result.length, 3);
    assert.equal(result[0].cache_control, void 0);
    assert.equal(result[1].cache_control, void 0);
    assert.deepEqual(result[2].cache_control, { type: "ephemeral" });
  });
  it("does not add cache_control when cacheControl is undefined", () => {
    const tools = [makeTool("Read"), makeTool("Write")];
    const result = convertTools(tools, false);
    for (const tool of result) {
      assert.equal(tool.cache_control, void 0);
    }
  });
  it("handles empty tools array without error", () => {
    const result = convertTools([], false, { type: "ephemeral" });
    assert.equal(result.length, 0);
  });
  it("passes through ttl when provided", () => {
    const tools = [makeTool("Read")];
    const cacheControl = { type: "ephemeral", ttl: "1h" };
    const result = convertTools(tools, false, cacheControl);
    assert.deepEqual(result[0].cache_control, { type: "ephemeral", ttl: "1h" });
  });
  it("single tool gets cache_control", () => {
    const tools = [makeTool("Read")];
    const result = convertTools(tools, false, { type: "ephemeral" });
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].cache_control, { type: "ephemeral" });
  });
});
describe("mapThinkingLevelToEffort", () => {
  it("maps xhigh to max for opus-4-6 (no native xhigh support)", () => {
    assert.equal(mapThinkingLevelToEffort("xhigh", "claude-opus-4-6"), "max");
  });
  it("maps xhigh to xhigh natively for opus-4-7", () => {
    assert.equal(mapThinkingLevelToEffort("xhigh", "claude-opus-4-7"), "xhigh");
  });
  it("maps high to high for opus-4-7", () => {
    assert.equal(mapThinkingLevelToEffort("high", "claude-opus-4-7"), "high");
  });
});
describe("mapStopReason", () => {
  it("maps end_turn to stop", () => {
    assert.equal(mapStopReason("end_turn"), "stop");
  });
  it("maps max_tokens to length", () => {
    assert.equal(mapStopReason("max_tokens"), "length");
  });
  it("maps tool_use to toolUse", () => {
    assert.equal(mapStopReason("tool_use"), "toolUse");
  });
  it("maps pause_turn to pauseTurn (not stop)", () => {
    assert.equal(mapStopReason("pause_turn"), "pauseTurn");
  });
  it("throws on unknown stop reason", () => {
    assert.throws(() => mapStopReason("bogus"), /Unhandled stop reason/);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL3Byb3ZpZGVycy9hbnRocm9waWMtc2hhcmVkLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGRlc2NyaWJlLCBpdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgY29udmVydFRvb2xzLCBtYXBTdG9wUmVhc29uLCBtYXBUaGlua2luZ0xldmVsVG9FZmZvcnQgfSBmcm9tIFwiLi9hbnRocm9waWMtc2hhcmVkLmpzXCI7XG5cbmNvbnN0IG1ha2VUb29sID0gKG5hbWU6IHN0cmluZykgPT5cblx0KHtcblx0XHRuYW1lLFxuXHRcdGRlc2NyaXB0aW9uOiBgZGVzYyBmb3IgJHtuYW1lfWAsXG5cdFx0cGFyYW1ldGVyczoge1xuXHRcdFx0dHlwZTogXCJvYmplY3RcIiBhcyBjb25zdCxcblx0XHRcdHByb3BlcnRpZXM6IHsgYXJnOiB7IHR5cGU6IFwic3RyaW5nXCIgfSB9LFxuXHRcdFx0cmVxdWlyZWQ6IFtcImFyZ1wiXSxcblx0XHR9LFxuXHR9KSBhcyBhbnk7XG5cbmRlc2NyaWJlKFwiY29udmVydFRvb2xzIGNhY2hlX2NvbnRyb2xcIiwgKCkgPT4ge1xuXHRpdChcImFkZHMgY2FjaGVfY29udHJvbCB0byB0aGUgbGFzdCB0b29sIHdoZW4gY2FjaGVDb250cm9sIGlzIHByb3ZpZGVkXCIsICgpID0+IHtcblx0XHRjb25zdCB0b29scyA9IFttYWtlVG9vbChcIlJlYWRcIiksIG1ha2VUb29sKFwiV3JpdGVcIiksIG1ha2VUb29sKFwiRWRpdFwiKV07XG5cdFx0Y29uc3QgY2FjaGVDb250cm9sID0geyB0eXBlOiBcImVwaGVtZXJhbFwiIGFzIGNvbnN0IH07XG5cdFx0Y29uc3QgcmVzdWx0ID0gY29udmVydFRvb2xzKHRvb2xzLCBmYWxzZSwgY2FjaGVDb250cm9sKTtcblxuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQubGVuZ3RoLCAzKTtcblx0XHRhc3NlcnQuZXF1YWwoKHJlc3VsdFswXSBhcyBhbnkpLmNhY2hlX2NvbnRyb2wsIHVuZGVmaW5lZCk7XG5cdFx0YXNzZXJ0LmVxdWFsKChyZXN1bHRbMV0gYXMgYW55KS5jYWNoZV9jb250cm9sLCB1bmRlZmluZWQpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoKHJlc3VsdFsyXSBhcyBhbnkpLmNhY2hlX2NvbnRyb2wsIHsgdHlwZTogXCJlcGhlbWVyYWxcIiB9KTtcblx0fSk7XG5cblx0aXQoXCJkb2VzIG5vdCBhZGQgY2FjaGVfY29udHJvbCB3aGVuIGNhY2hlQ29udHJvbCBpcyB1bmRlZmluZWRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHRvb2xzID0gW21ha2VUb29sKFwiUmVhZFwiKSwgbWFrZVRvb2woXCJXcml0ZVwiKV07XG5cdFx0Y29uc3QgcmVzdWx0ID0gY29udmVydFRvb2xzKHRvb2xzLCBmYWxzZSk7XG5cblx0XHRmb3IgKGNvbnN0IHRvb2wgb2YgcmVzdWx0KSB7XG5cdFx0XHRhc3NlcnQuZXF1YWwoKHRvb2wgYXMgYW55KS5jYWNoZV9jb250cm9sLCB1bmRlZmluZWQpO1xuXHRcdH1cblx0fSk7XG5cblx0aXQoXCJoYW5kbGVzIGVtcHR5IHRvb2xzIGFycmF5IHdpdGhvdXQgZXJyb3JcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IGNvbnZlcnRUb29scyhbXSwgZmFsc2UsIHsgdHlwZTogXCJlcGhlbWVyYWxcIiB9KTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0Lmxlbmd0aCwgMCk7XG5cdH0pO1xuXG5cdGl0KFwicGFzc2VzIHRocm91Z2ggdHRsIHdoZW4gcHJvdmlkZWRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHRvb2xzID0gW21ha2VUb29sKFwiUmVhZFwiKV07XG5cdFx0Y29uc3QgY2FjaGVDb250cm9sID0geyB0eXBlOiBcImVwaGVtZXJhbFwiIGFzIGNvbnN0LCB0dGw6IFwiMWhcIiBhcyBjb25zdCB9O1xuXHRcdGNvbnN0IHJlc3VsdCA9IGNvbnZlcnRUb29scyh0b29scywgZmFsc2UsIGNhY2hlQ29udHJvbCk7XG5cblx0XHRhc3NlcnQuZGVlcEVxdWFsKChyZXN1bHRbMF0gYXMgYW55KS5jYWNoZV9jb250cm9sLCB7IHR5cGU6IFwiZXBoZW1lcmFsXCIsIHR0bDogXCIxaFwiIH0pO1xuXHR9KTtcblxuXHRpdChcInNpbmdsZSB0b29sIGdldHMgY2FjaGVfY29udHJvbFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgdG9vbHMgPSBbbWFrZVRvb2woXCJSZWFkXCIpXTtcblx0XHRjb25zdCByZXN1bHQgPSBjb252ZXJ0VG9vbHModG9vbHMsIGZhbHNlLCB7IHR5cGU6IFwiZXBoZW1lcmFsXCIgfSk7XG5cblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0Lmxlbmd0aCwgMSk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbCgocmVzdWx0WzBdIGFzIGFueSkuY2FjaGVfY29udHJvbCwgeyB0eXBlOiBcImVwaGVtZXJhbFwiIH0pO1xuXHR9KTtcbn0pO1xuXG5kZXNjcmliZShcIm1hcFRoaW5raW5nTGV2ZWxUb0VmZm9ydFwiLCAoKSA9PiB7XG5cdGl0KFwibWFwcyB4aGlnaCB0byBtYXggZm9yIG9wdXMtNC02IChubyBuYXRpdmUgeGhpZ2ggc3VwcG9ydClcIiwgKCkgPT4ge1xuXHRcdGFzc2VydC5lcXVhbChtYXBUaGlua2luZ0xldmVsVG9FZmZvcnQoXCJ4aGlnaFwiLCBcImNsYXVkZS1vcHVzLTQtNlwiKSwgXCJtYXhcIik7XG5cdH0pO1xuXG5cdGl0KFwibWFwcyB4aGlnaCB0byB4aGlnaCBuYXRpdmVseSBmb3Igb3B1cy00LTdcIiwgKCkgPT4ge1xuXHRcdGFzc2VydC5lcXVhbChtYXBUaGlua2luZ0xldmVsVG9FZmZvcnQoXCJ4aGlnaFwiLCBcImNsYXVkZS1vcHVzLTQtN1wiKSwgXCJ4aGlnaFwiKTtcblx0fSk7XG5cblx0aXQoXCJtYXBzIGhpZ2ggdG8gaGlnaCBmb3Igb3B1cy00LTdcIiwgKCkgPT4ge1xuXHRcdGFzc2VydC5lcXVhbChtYXBUaGlua2luZ0xldmVsVG9FZmZvcnQoXCJoaWdoXCIsIFwiY2xhdWRlLW9wdXMtNC03XCIpLCBcImhpZ2hcIik7XG5cdH0pO1xufSk7XG5cbmRlc2NyaWJlKFwibWFwU3RvcFJlYXNvblwiLCAoKSA9PiB7XG5cdGl0KFwibWFwcyBlbmRfdHVybiB0byBzdG9wXCIsICgpID0+IHtcblx0XHRhc3NlcnQuZXF1YWwobWFwU3RvcFJlYXNvbihcImVuZF90dXJuXCIpLCBcInN0b3BcIik7XG5cdH0pO1xuXG5cdGl0KFwibWFwcyBtYXhfdG9rZW5zIHRvIGxlbmd0aFwiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmVxdWFsKG1hcFN0b3BSZWFzb24oXCJtYXhfdG9rZW5zXCIpLCBcImxlbmd0aFwiKTtcblx0fSk7XG5cblx0aXQoXCJtYXBzIHRvb2xfdXNlIHRvIHRvb2xVc2VcIiwgKCkgPT4ge1xuXHRcdGFzc2VydC5lcXVhbChtYXBTdG9wUmVhc29uKFwidG9vbF91c2VcIiksIFwidG9vbFVzZVwiKTtcblx0fSk7XG5cblx0aXQoXCJtYXBzIHBhdXNlX3R1cm4gdG8gcGF1c2VUdXJuIChub3Qgc3RvcClcIiwgKCkgPT4ge1xuXHRcdC8vIHBhdXNlX3R1cm4gbWVhbnMgdGhlIHNlcnZlciBwYXVzZWQgYSBsb25nLXJ1bm5pbmcgdHVybiAoZS5nLiBuYXRpdmVcblx0XHQvLyB3ZWIgc2VhcmNoIGhpdCBpdHMgaXRlcmF0aW9uIGxpbWl0KS4gTWFwcGluZyBpdCB0byBcInN0b3BcIiBjYXVzZXMgdGhlXG5cdFx0Ly8gYWdlbnQgbG9vcCB0byBleGl0LCBsZWF2aW5nIGFuIGluY29tcGxldGUgc2VydmVyX3Rvb2xfdXNlIGJsb2NrIGluXG5cdFx0Ly8gaGlzdG9yeSB3aGljaCB0cmlnZ2VycyBhIDQwMCBvbiB0aGUgbmV4dCByZXF1ZXN0LlxuXHRcdGFzc2VydC5lcXVhbChtYXBTdG9wUmVhc29uKFwicGF1c2VfdHVyblwiKSwgXCJwYXVzZVR1cm5cIik7XG5cdH0pO1xuXG5cdGl0KFwidGhyb3dzIG9uIHVua25vd24gc3RvcCByZWFzb25cIiwgKCkgPT4ge1xuXHRcdGFzc2VydC50aHJvd3MoKCkgPT4gbWFwU3RvcFJlYXNvbihcImJvZ3VzXCIpLCAvVW5oYW5kbGVkIHN0b3AgcmVhc29uLyk7XG5cdH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLFVBQVUsVUFBVTtBQUM3QixPQUFPLFlBQVk7QUFDbkIsU0FBUyxjQUFjLGVBQWUsZ0NBQWdDO0FBRXRFLE1BQU0sV0FBVyxDQUFDLFVBQ2hCO0FBQUEsRUFDQTtBQUFBLEVBQ0EsYUFBYSxZQUFZLElBQUk7QUFBQSxFQUM3QixZQUFZO0FBQUEsSUFDWCxNQUFNO0FBQUEsSUFDTixZQUFZLEVBQUUsS0FBSyxFQUFFLE1BQU0sU0FBUyxFQUFFO0FBQUEsSUFDdEMsVUFBVSxDQUFDLEtBQUs7QUFBQSxFQUNqQjtBQUNEO0FBRUQsU0FBUyw4QkFBOEIsTUFBTTtBQUM1QyxLQUFHLHFFQUFxRSxNQUFNO0FBQzdFLFVBQU0sUUFBUSxDQUFDLFNBQVMsTUFBTSxHQUFHLFNBQVMsT0FBTyxHQUFHLFNBQVMsTUFBTSxDQUFDO0FBQ3BFLFVBQU0sZUFBZSxFQUFFLE1BQU0sWUFBcUI7QUFDbEQsVUFBTSxTQUFTLGFBQWEsT0FBTyxPQUFPLFlBQVk7QUFFdEQsV0FBTyxNQUFNLE9BQU8sUUFBUSxDQUFDO0FBQzdCLFdBQU8sTUFBTyxPQUFPLENBQUMsRUFBVSxlQUFlLE1BQVM7QUFDeEQsV0FBTyxNQUFPLE9BQU8sQ0FBQyxFQUFVLGVBQWUsTUFBUztBQUN4RCxXQUFPLFVBQVcsT0FBTyxDQUFDLEVBQVUsZUFBZSxFQUFFLE1BQU0sWUFBWSxDQUFDO0FBQUEsRUFDekUsQ0FBQztBQUVELEtBQUcsNkRBQTZELE1BQU07QUFDckUsVUFBTSxRQUFRLENBQUMsU0FBUyxNQUFNLEdBQUcsU0FBUyxPQUFPLENBQUM7QUFDbEQsVUFBTSxTQUFTLGFBQWEsT0FBTyxLQUFLO0FBRXhDLGVBQVcsUUFBUSxRQUFRO0FBQzFCLGFBQU8sTUFBTyxLQUFhLGVBQWUsTUFBUztBQUFBLElBQ3BEO0FBQUEsRUFDRCxDQUFDO0FBRUQsS0FBRywyQ0FBMkMsTUFBTTtBQUNuRCxVQUFNLFNBQVMsYUFBYSxDQUFDLEdBQUcsT0FBTyxFQUFFLE1BQU0sWUFBWSxDQUFDO0FBQzVELFdBQU8sTUFBTSxPQUFPLFFBQVEsQ0FBQztBQUFBLEVBQzlCLENBQUM7QUFFRCxLQUFHLG9DQUFvQyxNQUFNO0FBQzVDLFVBQU0sUUFBUSxDQUFDLFNBQVMsTUFBTSxDQUFDO0FBQy9CLFVBQU0sZUFBZSxFQUFFLE1BQU0sYUFBc0IsS0FBSyxLQUFjO0FBQ3RFLFVBQU0sU0FBUyxhQUFhLE9BQU8sT0FBTyxZQUFZO0FBRXRELFdBQU8sVUFBVyxPQUFPLENBQUMsRUFBVSxlQUFlLEVBQUUsTUFBTSxhQUFhLEtBQUssS0FBSyxDQUFDO0FBQUEsRUFDcEYsQ0FBQztBQUVELEtBQUcsa0NBQWtDLE1BQU07QUFDMUMsVUFBTSxRQUFRLENBQUMsU0FBUyxNQUFNLENBQUM7QUFDL0IsVUFBTSxTQUFTLGFBQWEsT0FBTyxPQUFPLEVBQUUsTUFBTSxZQUFZLENBQUM7QUFFL0QsV0FBTyxNQUFNLE9BQU8sUUFBUSxDQUFDO0FBQzdCLFdBQU8sVUFBVyxPQUFPLENBQUMsRUFBVSxlQUFlLEVBQUUsTUFBTSxZQUFZLENBQUM7QUFBQSxFQUN6RSxDQUFDO0FBQ0YsQ0FBQztBQUVELFNBQVMsNEJBQTRCLE1BQU07QUFDMUMsS0FBRyw0REFBNEQsTUFBTTtBQUNwRSxXQUFPLE1BQU0seUJBQXlCLFNBQVMsaUJBQWlCLEdBQUcsS0FBSztBQUFBLEVBQ3pFLENBQUM7QUFFRCxLQUFHLDZDQUE2QyxNQUFNO0FBQ3JELFdBQU8sTUFBTSx5QkFBeUIsU0FBUyxpQkFBaUIsR0FBRyxPQUFPO0FBQUEsRUFDM0UsQ0FBQztBQUVELEtBQUcsa0NBQWtDLE1BQU07QUFDMUMsV0FBTyxNQUFNLHlCQUF5QixRQUFRLGlCQUFpQixHQUFHLE1BQU07QUFBQSxFQUN6RSxDQUFDO0FBQ0YsQ0FBQztBQUVELFNBQVMsaUJBQWlCLE1BQU07QUFDL0IsS0FBRyx5QkFBeUIsTUFBTTtBQUNqQyxXQUFPLE1BQU0sY0FBYyxVQUFVLEdBQUcsTUFBTTtBQUFBLEVBQy9DLENBQUM7QUFFRCxLQUFHLDZCQUE2QixNQUFNO0FBQ3JDLFdBQU8sTUFBTSxjQUFjLFlBQVksR0FBRyxRQUFRO0FBQUEsRUFDbkQsQ0FBQztBQUVELEtBQUcsNEJBQTRCLE1BQU07QUFDcEMsV0FBTyxNQUFNLGNBQWMsVUFBVSxHQUFHLFNBQVM7QUFBQSxFQUNsRCxDQUFDO0FBRUQsS0FBRywyQ0FBMkMsTUFBTTtBQUtuRCxXQUFPLE1BQU0sY0FBYyxZQUFZLEdBQUcsV0FBVztBQUFBLEVBQ3RELENBQUM7QUFFRCxLQUFHLGlDQUFpQyxNQUFNO0FBQ3pDLFdBQU8sT0FBTyxNQUFNLGNBQWMsT0FBTyxHQUFHLHVCQUF1QjtBQUFBLEVBQ3BFLENBQUM7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
