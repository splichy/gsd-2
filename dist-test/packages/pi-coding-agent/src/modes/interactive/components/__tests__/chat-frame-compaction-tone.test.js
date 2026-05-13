import { test, describe } from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";
import { renderChatFrame } from "../chat-frame.js";
import { initTheme } from "../../theme/theme.js";
initTheme("dark", false);
describe("renderChatFrame \u2014 compaction tone", () => {
  test("produces a top rule, compaction header row, and a \u2502 body margin", () => {
    const lines = renderChatFrame(
      ["Compacted from 1,224,262 tokens (ctrl+o to expand)"],
      60,
      {
        label: "compaction",
        tone: "compaction",
        timestampFormat: "date-time-iso",
        showTimestamp: false
      }
    );
    assert.ok(lines.length >= 3, `expected at least 3 frame lines, got ${lines.length}`);
    const plain = lines.map((line) => stripAnsi(line));
    assert.match(plain[0], /^─+$/, "first line should be the solid top rule");
    assert.ok(
      plain[1].includes("compaction"),
      `expected header to contain "compaction", got ${JSON.stringify(plain[1])}`
    );
    assert.ok(!plain[1].includes("\u2022"), `header should not render a bullet prefix, got ${JSON.stringify(plain[1])}`);
    assert.ok(
      plain[2].startsWith("\u2502 "),
      `expected body line to start with "\u2502 ", got ${JSON.stringify(plain[2])}`
    );
    assert.ok(
      plain[2].includes("Compacted from 1,224,262 tokens"),
      "body line should include the original content"
    );
  });
  test("does not render a right-aligned timestamp when showTimestamp is false", () => {
    const lines = renderChatFrame(["body"], 60, {
      label: "compaction",
      tone: "compaction",
      timestamp: Date.now(),
      timestampFormat: "date-time-iso",
      showTimestamp: false
    });
    const header = stripAnsi(lines[1]);
    assert.ok(
      !/\b20\d{2}\b/.test(header),
      `timestamp should be suppressed when showTimestamp=false, got ${JSON.stringify(header)}`
    );
  });
  test("emits ANSI color codes distinct from the assistant tone", () => {
    const assistantFrame = renderChatFrame(["body"], 60, {
      label: "claude",
      tone: "assistant",
      timestampFormat: "date-time-iso",
      showTimestamp: false
    }).join("\n");
    const compactionFrame = renderChatFrame(["body"], 60, {
      label: "compaction",
      tone: "compaction",
      timestampFormat: "date-time-iso",
      showTimestamp: false
    }).join("\n");
    assert.ok(
      assistantFrame !== compactionFrame,
      "compaction tone must produce a different styled output than assistant tone"
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9jb21wb25lbnRzL19fdGVzdHNfXy9jaGF0LWZyYW1lLWNvbXBhY3Rpb24tdG9uZS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QyIFRVSSBUZXN0cyAtIENoYXQgZnJhbWUgY2FyZCB2aXN1YWwgY29udHJhY3QgY292ZXJhZ2UuXG5pbXBvcnQgeyB0ZXN0LCBkZXNjcmliZSB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHN0cmlwQW5zaSBmcm9tIFwic3RyaXAtYW5zaVwiO1xuaW1wb3J0IHsgcmVuZGVyQ2hhdEZyYW1lIH0gZnJvbSBcIi4uL2NoYXQtZnJhbWUuanNcIjtcbmltcG9ydCB7IGluaXRUaGVtZSB9IGZyb20gXCIuLi8uLi90aGVtZS90aGVtZS5qc1wiO1xuXG5pbml0VGhlbWUoXCJkYXJrXCIsIGZhbHNlKTtcblxuLy8gUmVncmVzc2lvbiB0ZXN0cyBmb3IgdGhlIFwiY29tcGFjdGlvblwiIHRvbmUgYWRkZWQgdG8gcmVuZGVyQ2hhdEZyYW1lLlxuLy8gVGhlIGNvbXBhY3Rpb24gbm90aWNlIHNoYXJlcyB0aGUgc2FtZSB2aXN1YWwgZnJhbWUgYXMgdXNlciAvIGFzc2lzdGFudFxuLy8gbWVzc2FnZXMgKHRvcCBydWxlLCBsYWJlbCBoZWFkZXIsIGBcdTI1MDIgYCBib2R5IHByZWZpeCkgYnV0IHVzZXMgdGhlXG4vLyBwdXJwbGUgYGN1c3RvbU1lc3NhZ2VMYWJlbGAgY29sb3Iga2V5IHNvIGl0IGlzIHZpc3VhbGx5IGRpc3RpbmN0IGZyb21cbi8vIGNvbnZlcnNhdGlvbiB0dXJucy5cblxuZGVzY3JpYmUoXCJyZW5kZXJDaGF0RnJhbWUgXHUyMDE0IGNvbXBhY3Rpb24gdG9uZVwiLCAoKSA9PiB7XG5cdHRlc3QoXCJwcm9kdWNlcyBhIHRvcCBydWxlLCBjb21wYWN0aW9uIGhlYWRlciByb3csIGFuZCBhIFx1MjUwMiBib2R5IG1hcmdpblwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbGluZXMgPSByZW5kZXJDaGF0RnJhbWUoXG5cdFx0XHRbXCJDb21wYWN0ZWQgZnJvbSAxLDIyNCwyNjIgdG9rZW5zIChjdHJsK28gdG8gZXhwYW5kKVwiXSxcblx0XHRcdDYwLFxuXHRcdFx0e1xuXHRcdFx0XHRsYWJlbDogXCJjb21wYWN0aW9uXCIsXG5cdFx0XHRcdHRvbmU6IFwiY29tcGFjdGlvblwiLFxuXHRcdFx0XHR0aW1lc3RhbXBGb3JtYXQ6IFwiZGF0ZS10aW1lLWlzb1wiLFxuXHRcdFx0XHRzaG93VGltZXN0YW1wOiBmYWxzZSxcblx0XHRcdH0sXG5cdFx0KTtcblxuXHRcdC8vIFN0cnVjdHVyZTogdG9wIHJ1bGUsIGhlYWRlciwgYm9keSBsaW5lKHMpXG5cdFx0YXNzZXJ0Lm9rKGxpbmVzLmxlbmd0aCA+PSAzLCBgZXhwZWN0ZWQgYXQgbGVhc3QgMyBmcmFtZSBsaW5lcywgZ290ICR7bGluZXMubGVuZ3RofWApO1xuXG5cdFx0Y29uc3QgcGxhaW4gPSBsaW5lcy5tYXAoKGxpbmUpID0+IHN0cmlwQW5zaShsaW5lKSk7XG5cblx0XHQvLyBUb3AgcnVsZSBpcyBhIHNvbGlkIGhvcml6b250YWwgYmFyXG5cdFx0YXNzZXJ0Lm1hdGNoKHBsYWluWzBdLCAvXlx1MjUwMCskLywgXCJmaXJzdCBsaW5lIHNob3VsZCBiZSB0aGUgc29saWQgdG9wIHJ1bGVcIik7XG5cblx0XHQvLyBIZWFkZXIgcm93IGNvbnRhaW5zIGBjb21wYWN0aW9uYFxuXHRcdGFzc2VydC5vayhcblx0XHRcdHBsYWluWzFdLmluY2x1ZGVzKFwiY29tcGFjdGlvblwiKSxcblx0XHRcdGBleHBlY3RlZCBoZWFkZXIgdG8gY29udGFpbiBcImNvbXBhY3Rpb25cIiwgZ290ICR7SlNPTi5zdHJpbmdpZnkocGxhaW5bMV0pfWAsXG5cdFx0KTtcblx0XHRhc3NlcnQub2soIXBsYWluWzFdLmluY2x1ZGVzKFwiXHUyMDIyXCIpLCBgaGVhZGVyIHNob3VsZCBub3QgcmVuZGVyIGEgYnVsbGV0IHByZWZpeCwgZ290ICR7SlNPTi5zdHJpbmdpZnkocGxhaW5bMV0pfWApO1xuXG5cdFx0Ly8gQm9keSBsaW5lKHMpIHN0YXJ0IHdpdGggYFx1MjUwMiBgXG5cdFx0YXNzZXJ0Lm9rKFxuXHRcdFx0cGxhaW5bMl0uc3RhcnRzV2l0aChcIlx1MjUwMiBcIiksXG5cdFx0XHRgZXhwZWN0ZWQgYm9keSBsaW5lIHRvIHN0YXJ0IHdpdGggXCJcdTI1MDIgXCIsIGdvdCAke0pTT04uc3RyaW5naWZ5KHBsYWluWzJdKX1gLFxuXHRcdCk7XG5cdFx0YXNzZXJ0Lm9rKFxuXHRcdFx0cGxhaW5bMl0uaW5jbHVkZXMoXCJDb21wYWN0ZWQgZnJvbSAxLDIyNCwyNjIgdG9rZW5zXCIpLFxuXHRcdFx0XCJib2R5IGxpbmUgc2hvdWxkIGluY2x1ZGUgdGhlIG9yaWdpbmFsIGNvbnRlbnRcIixcblx0XHQpO1xuXHR9KTtcblxuXHR0ZXN0KFwiZG9lcyBub3QgcmVuZGVyIGEgcmlnaHQtYWxpZ25lZCB0aW1lc3RhbXAgd2hlbiBzaG93VGltZXN0YW1wIGlzIGZhbHNlXCIsICgpID0+IHtcblx0XHRjb25zdCBsaW5lcyA9IHJlbmRlckNoYXRGcmFtZShbXCJib2R5XCJdLCA2MCwge1xuXHRcdFx0bGFiZWw6IFwiY29tcGFjdGlvblwiLFxuXHRcdFx0dG9uZTogXCJjb21wYWN0aW9uXCIsXG5cdFx0XHR0aW1lc3RhbXA6IERhdGUubm93KCksXG5cdFx0XHR0aW1lc3RhbXBGb3JtYXQ6IFwiZGF0ZS10aW1lLWlzb1wiLFxuXHRcdFx0c2hvd1RpbWVzdGFtcDogZmFsc2UsXG5cdFx0fSk7XG5cblx0XHRjb25zdCBoZWFkZXIgPSBzdHJpcEFuc2kobGluZXNbMV0pO1xuXHRcdC8vIE5vIGZvdXItZGlnaXQgeWVhciBzaG91bGQgYXBwZWFyIGFueXdoZXJlIGluIHRoZSBoZWFkZXIgcm93XG5cdFx0YXNzZXJ0Lm9rKFxuXHRcdFx0IS9cXGIyMFxcZHsyfVxcYi8udGVzdChoZWFkZXIpLFxuXHRcdFx0YHRpbWVzdGFtcCBzaG91bGQgYmUgc3VwcHJlc3NlZCB3aGVuIHNob3dUaW1lc3RhbXA9ZmFsc2UsIGdvdCAke0pTT04uc3RyaW5naWZ5KGhlYWRlcil9YCxcblx0XHQpO1xuXHR9KTtcblxuXHR0ZXN0KFwiZW1pdHMgQU5TSSBjb2xvciBjb2RlcyBkaXN0aW5jdCBmcm9tIHRoZSBhc3Npc3RhbnQgdG9uZVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgYXNzaXN0YW50RnJhbWUgPSByZW5kZXJDaGF0RnJhbWUoW1wiYm9keVwiXSwgNjAsIHtcblx0XHRcdGxhYmVsOiBcImNsYXVkZVwiLFxuXHRcdFx0dG9uZTogXCJhc3Npc3RhbnRcIixcblx0XHRcdHRpbWVzdGFtcEZvcm1hdDogXCJkYXRlLXRpbWUtaXNvXCIsXG5cdFx0XHRzaG93VGltZXN0YW1wOiBmYWxzZSxcblx0XHR9KS5qb2luKFwiXFxuXCIpO1xuXG5cdFx0Y29uc3QgY29tcGFjdGlvbkZyYW1lID0gcmVuZGVyQ2hhdEZyYW1lKFtcImJvZHlcIl0sIDYwLCB7XG5cdFx0XHRsYWJlbDogXCJjb21wYWN0aW9uXCIsXG5cdFx0XHR0b25lOiBcImNvbXBhY3Rpb25cIixcblx0XHRcdHRpbWVzdGFtcEZvcm1hdDogXCJkYXRlLXRpbWUtaXNvXCIsXG5cdFx0XHRzaG93VGltZXN0YW1wOiBmYWxzZSxcblx0XHR9KS5qb2luKFwiXFxuXCIpO1xuXG5cdFx0Ly8gQm90aCBmcmFtZXMgY2FycnkgQU5TSTsgdGhlIGNvbXBhY3Rpb24gZnJhbWUgc2hvdWxkIG5vdCBiZSBpZGVudGljYWxcblx0XHQvLyB0byB0aGUgYXNzaXN0YW50IGZyYW1lIChkaWZmZXJlbnQgY29sb3IgbWFwcGluZ3MpLlxuXHRcdGFzc2VydC5vayhcblx0XHRcdGFzc2lzdGFudEZyYW1lICE9PSBjb21wYWN0aW9uRnJhbWUsXG5cdFx0XHRcImNvbXBhY3Rpb24gdG9uZSBtdXN0IHByb2R1Y2UgYSBkaWZmZXJlbnQgc3R5bGVkIG91dHB1dCB0aGFuIGFzc2lzdGFudCB0b25lXCIsXG5cdFx0KTtcblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUNBLFNBQVMsTUFBTSxnQkFBZ0I7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLE9BQU8sZUFBZTtBQUN0QixTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLGlCQUFpQjtBQUUxQixVQUFVLFFBQVEsS0FBSztBQVF2QixTQUFTLDBDQUFxQyxNQUFNO0FBQ25ELE9BQUssd0VBQW1FLE1BQU07QUFDN0UsVUFBTSxRQUFRO0FBQUEsTUFDYixDQUFDLG9EQUFvRDtBQUFBLE1BQ3JEO0FBQUEsTUFDQTtBQUFBLFFBQ0MsT0FBTztBQUFBLFFBQ1AsTUFBTTtBQUFBLFFBQ04saUJBQWlCO0FBQUEsUUFDakIsZUFBZTtBQUFBLE1BQ2hCO0FBQUEsSUFDRDtBQUdBLFdBQU8sR0FBRyxNQUFNLFVBQVUsR0FBRyx3Q0FBd0MsTUFBTSxNQUFNLEVBQUU7QUFFbkYsVUFBTSxRQUFRLE1BQU0sSUFBSSxDQUFDLFNBQVMsVUFBVSxJQUFJLENBQUM7QUFHakQsV0FBTyxNQUFNLE1BQU0sQ0FBQyxHQUFHLFFBQVEseUNBQXlDO0FBR3hFLFdBQU87QUFBQSxNQUNOLE1BQU0sQ0FBQyxFQUFFLFNBQVMsWUFBWTtBQUFBLE1BQzlCLGdEQUFnRCxLQUFLLFVBQVUsTUFBTSxDQUFDLENBQUMsQ0FBQztBQUFBLElBQ3pFO0FBQ0EsV0FBTyxHQUFHLENBQUMsTUFBTSxDQUFDLEVBQUUsU0FBUyxRQUFHLEdBQUcsaURBQWlELEtBQUssVUFBVSxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFHOUcsV0FBTztBQUFBLE1BQ04sTUFBTSxDQUFDLEVBQUUsV0FBVyxTQUFJO0FBQUEsTUFDeEIsbURBQThDLEtBQUssVUFBVSxNQUFNLENBQUMsQ0FBQyxDQUFDO0FBQUEsSUFDdkU7QUFDQSxXQUFPO0FBQUEsTUFDTixNQUFNLENBQUMsRUFBRSxTQUFTLGlDQUFpQztBQUFBLE1BQ25EO0FBQUEsSUFDRDtBQUFBLEVBQ0QsQ0FBQztBQUVELE9BQUsseUVBQXlFLE1BQU07QUFDbkYsVUFBTSxRQUFRLGdCQUFnQixDQUFDLE1BQU0sR0FBRyxJQUFJO0FBQUEsTUFDM0MsT0FBTztBQUFBLE1BQ1AsTUFBTTtBQUFBLE1BQ04sV0FBVyxLQUFLLElBQUk7QUFBQSxNQUNwQixpQkFBaUI7QUFBQSxNQUNqQixlQUFlO0FBQUEsSUFDaEIsQ0FBQztBQUVELFVBQU0sU0FBUyxVQUFVLE1BQU0sQ0FBQyxDQUFDO0FBRWpDLFdBQU87QUFBQSxNQUNOLENBQUMsY0FBYyxLQUFLLE1BQU07QUFBQSxNQUMxQixnRUFBZ0UsS0FBSyxVQUFVLE1BQU0sQ0FBQztBQUFBLElBQ3ZGO0FBQUEsRUFDRCxDQUFDO0FBRUQsT0FBSywyREFBMkQsTUFBTTtBQUNyRSxVQUFNLGlCQUFpQixnQkFBZ0IsQ0FBQyxNQUFNLEdBQUcsSUFBSTtBQUFBLE1BQ3BELE9BQU87QUFBQSxNQUNQLE1BQU07QUFBQSxNQUNOLGlCQUFpQjtBQUFBLE1BQ2pCLGVBQWU7QUFBQSxJQUNoQixDQUFDLEVBQUUsS0FBSyxJQUFJO0FBRVosVUFBTSxrQkFBa0IsZ0JBQWdCLENBQUMsTUFBTSxHQUFHLElBQUk7QUFBQSxNQUNyRCxPQUFPO0FBQUEsTUFDUCxNQUFNO0FBQUEsTUFDTixpQkFBaUI7QUFBQSxNQUNqQixlQUFlO0FBQUEsSUFDaEIsQ0FBQyxFQUFFLEtBQUssSUFBSTtBQUlaLFdBQU87QUFBQSxNQUNOLG1CQUFtQjtBQUFBLE1BQ25CO0FBQUEsSUFDRDtBQUFBLEVBQ0QsQ0FBQztBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
