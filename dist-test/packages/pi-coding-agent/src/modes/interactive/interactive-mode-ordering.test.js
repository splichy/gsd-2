import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAssistantReplaySegments } from "./interactive-mode.js";
test("buildAssistantReplaySegments preserves tool-first ordering", () => {
  const segments = buildAssistantReplaySegments([
    { type: "toolCall", id: "t1", name: "read", arguments: {} },
    { type: "text", text: "Done." }
  ]);
  assert.deepEqual(segments, [
    { kind: "tool", contentIndex: 0 },
    { kind: "assistant", startIndex: 1, endIndex: 1 }
  ]);
});
test("buildAssistantReplaySegments preserves interleaved assistant-tool-assistant runs", () => {
  const segments = buildAssistantReplaySegments([
    { type: "text", text: "Let me check." },
    { type: "serverToolUse", id: "s1", name: "mcp__fs__glob", input: {} },
    { type: "thinking", thinking: "Tool result looks good." },
    { type: "text", text: "Here is the answer." }
  ]);
  assert.deepEqual(segments, [
    { kind: "assistant", startIndex: 0, endIndex: 0 },
    { kind: "tool", contentIndex: 1 },
    { kind: "assistant", startIndex: 2, endIndex: 3 }
  ]);
});
test("buildAssistantReplaySegments ignores non-rendered non-tool blocks", () => {
  const segments = buildAssistantReplaySegments([
    { type: "text", text: "before" },
    { type: "webSearchResult", toolUseId: "s1", content: {} },
    { type: "text", text: "after" }
  ]);
  assert.deepEqual(segments, [
    { kind: "assistant", startIndex: 0, endIndex: 0 },
    { kind: "assistant", startIndex: 2, endIndex: 2 }
  ]);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9pbnRlcmFjdGl2ZS1tb2RlLW9yZGVyaW5nLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcblxuaW1wb3J0IHsgYnVpbGRBc3Npc3RhbnRSZXBsYXlTZWdtZW50cyB9IGZyb20gXCIuL2ludGVyYWN0aXZlLW1vZGUuanNcIjtcblxudGVzdChcImJ1aWxkQXNzaXN0YW50UmVwbGF5U2VnbWVudHMgcHJlc2VydmVzIHRvb2wtZmlyc3Qgb3JkZXJpbmdcIiwgKCkgPT4ge1xuXHRjb25zdCBzZWdtZW50cyA9IGJ1aWxkQXNzaXN0YW50UmVwbGF5U2VnbWVudHMoW1xuXHRcdHsgdHlwZTogXCJ0b29sQ2FsbFwiLCBpZDogXCJ0MVwiLCBuYW1lOiBcInJlYWRcIiwgYXJndW1lbnRzOiB7fSB9LFxuXHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiRG9uZS5cIiB9LFxuXHRdKTtcblxuXHRhc3NlcnQuZGVlcEVxdWFsKHNlZ21lbnRzLCBbXG5cdFx0eyBraW5kOiBcInRvb2xcIiwgY29udGVudEluZGV4OiAwIH0sXG5cdFx0eyBraW5kOiBcImFzc2lzdGFudFwiLCBzdGFydEluZGV4OiAxLCBlbmRJbmRleDogMSB9LFxuXHRdKTtcbn0pO1xuXG50ZXN0KFwiYnVpbGRBc3Npc3RhbnRSZXBsYXlTZWdtZW50cyBwcmVzZXJ2ZXMgaW50ZXJsZWF2ZWQgYXNzaXN0YW50LXRvb2wtYXNzaXN0YW50IHJ1bnNcIiwgKCkgPT4ge1xuXHRjb25zdCBzZWdtZW50cyA9IGJ1aWxkQXNzaXN0YW50UmVwbGF5U2VnbWVudHMoW1xuXHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiTGV0IG1lIGNoZWNrLlwiIH0sXG5cdFx0eyB0eXBlOiBcInNlcnZlclRvb2xVc2VcIiwgaWQ6IFwiczFcIiwgbmFtZTogXCJtY3BfX2ZzX19nbG9iXCIsIGlucHV0OiB7fSB9LFxuXHRcdHsgdHlwZTogXCJ0aGlua2luZ1wiLCB0aGlua2luZzogXCJUb29sIHJlc3VsdCBsb29rcyBnb29kLlwiIH0sXG5cdFx0eyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJIZXJlIGlzIHRoZSBhbnN3ZXIuXCIgfSxcblx0XSk7XG5cblx0YXNzZXJ0LmRlZXBFcXVhbChzZWdtZW50cywgW1xuXHRcdHsga2luZDogXCJhc3Npc3RhbnRcIiwgc3RhcnRJbmRleDogMCwgZW5kSW5kZXg6IDAgfSxcblx0XHR7IGtpbmQ6IFwidG9vbFwiLCBjb250ZW50SW5kZXg6IDEgfSxcblx0XHR7IGtpbmQ6IFwiYXNzaXN0YW50XCIsIHN0YXJ0SW5kZXg6IDIsIGVuZEluZGV4OiAzIH0sXG5cdF0pO1xufSk7XG5cbnRlc3QoXCJidWlsZEFzc2lzdGFudFJlcGxheVNlZ21lbnRzIGlnbm9yZXMgbm9uLXJlbmRlcmVkIG5vbi10b29sIGJsb2Nrc1wiLCAoKSA9PiB7XG5cdGNvbnN0IHNlZ21lbnRzID0gYnVpbGRBc3Npc3RhbnRSZXBsYXlTZWdtZW50cyhbXG5cdFx0eyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJiZWZvcmVcIiB9LFxuXHRcdHsgdHlwZTogXCJ3ZWJTZWFyY2hSZXN1bHRcIiwgdG9vbFVzZUlkOiBcInMxXCIsIGNvbnRlbnQ6IHt9IH0sXG5cdFx0eyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJhZnRlclwiIH0sXG5cdF0pO1xuXG5cdGFzc2VydC5kZWVwRXF1YWwoc2VnbWVudHMsIFtcblx0XHR7IGtpbmQ6IFwiYXNzaXN0YW50XCIsIHN0YXJ0SW5kZXg6IDAsIGVuZEluZGV4OiAwIH0sXG5cdFx0eyBraW5kOiBcImFzc2lzdGFudFwiLCBzdGFydEluZGV4OiAyLCBlbmRJbmRleDogMiB9LFxuXHRdKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxZQUFZO0FBQ25CLFNBQVMsWUFBWTtBQUVyQixTQUFTLG9DQUFvQztBQUU3QyxLQUFLLDhEQUE4RCxNQUFNO0FBQ3hFLFFBQU0sV0FBVyw2QkFBNkI7QUFBQSxJQUM3QyxFQUFFLE1BQU0sWUFBWSxJQUFJLE1BQU0sTUFBTSxRQUFRLFdBQVcsQ0FBQyxFQUFFO0FBQUEsSUFDMUQsRUFBRSxNQUFNLFFBQVEsTUFBTSxRQUFRO0FBQUEsRUFDL0IsQ0FBQztBQUVELFNBQU8sVUFBVSxVQUFVO0FBQUEsSUFDMUIsRUFBRSxNQUFNLFFBQVEsY0FBYyxFQUFFO0FBQUEsSUFDaEMsRUFBRSxNQUFNLGFBQWEsWUFBWSxHQUFHLFVBQVUsRUFBRTtBQUFBLEVBQ2pELENBQUM7QUFDRixDQUFDO0FBRUQsS0FBSyxvRkFBb0YsTUFBTTtBQUM5RixRQUFNLFdBQVcsNkJBQTZCO0FBQUEsSUFDN0MsRUFBRSxNQUFNLFFBQVEsTUFBTSxnQkFBZ0I7QUFBQSxJQUN0QyxFQUFFLE1BQU0saUJBQWlCLElBQUksTUFBTSxNQUFNLGlCQUFpQixPQUFPLENBQUMsRUFBRTtBQUFBLElBQ3BFLEVBQUUsTUFBTSxZQUFZLFVBQVUsMEJBQTBCO0FBQUEsSUFDeEQsRUFBRSxNQUFNLFFBQVEsTUFBTSxzQkFBc0I7QUFBQSxFQUM3QyxDQUFDO0FBRUQsU0FBTyxVQUFVLFVBQVU7QUFBQSxJQUMxQixFQUFFLE1BQU0sYUFBYSxZQUFZLEdBQUcsVUFBVSxFQUFFO0FBQUEsSUFDaEQsRUFBRSxNQUFNLFFBQVEsY0FBYyxFQUFFO0FBQUEsSUFDaEMsRUFBRSxNQUFNLGFBQWEsWUFBWSxHQUFHLFVBQVUsRUFBRTtBQUFBLEVBQ2pELENBQUM7QUFDRixDQUFDO0FBRUQsS0FBSyxxRUFBcUUsTUFBTTtBQUMvRSxRQUFNLFdBQVcsNkJBQTZCO0FBQUEsSUFDN0MsRUFBRSxNQUFNLFFBQVEsTUFBTSxTQUFTO0FBQUEsSUFDL0IsRUFBRSxNQUFNLG1CQUFtQixXQUFXLE1BQU0sU0FBUyxDQUFDLEVBQUU7QUFBQSxJQUN4RCxFQUFFLE1BQU0sUUFBUSxNQUFNLFFBQVE7QUFBQSxFQUMvQixDQUFDO0FBRUQsU0FBTyxVQUFVLFVBQVU7QUFBQSxJQUMxQixFQUFFLE1BQU0sYUFBYSxZQUFZLEdBQUcsVUFBVSxFQUFFO0FBQUEsSUFDaEQsRUFBRSxNQUFNLGFBQWEsWUFBWSxHQUFHLFVBQVUsRUFBRTtBQUFBLEVBQ2pELENBQUM7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
