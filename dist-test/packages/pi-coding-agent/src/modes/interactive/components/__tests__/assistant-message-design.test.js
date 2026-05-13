import { describe, test } from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";
import { initTheme } from "../../theme/theme.js";
import { AssistantMessageComponent } from "../assistant-message.js";
import { formatTimestamp } from "../timestamp.js";
initTheme("dark", false);
describe("AssistantMessageComponent recommended rail design", () => {
  test("renders assistant content with a lightly indented left rail", () => {
    const message = {
      id: "m1",
      role: "assistant",
      provider: "test",
      model: "gpt-test",
      timestamp: 1,
      content: [{ type: "text", text: "I will update the renderer and run verification." }]
    };
    const component = new AssistantMessageComponent(message, true);
    const raw = component.render(80);
    const plain = raw.map((line) => stripAnsi(line));
    const joined = plain.join("\n");
    assert.ok(plain.some((line) => line.startsWith("  \u2503 ")), `expected indented rail-prefixed lines:
${joined}`);
    assert.ok(raw.some((line) => line.includes("\x1B[48;")), `expected faint assistant block background:
${raw.join("\n")}`);
    assert.match(joined, /^\s*┃\s*$/m, "assistant block should include vertical padding rows");
    assert.match(joined, /GSD/);
    assert.match(joined, /gpt-test/);
    assert.match(joined, /update the renderer/);
    assert.doesNotMatch(joined, /^┃/m, "assistant rail should be slightly indented from the left edge");
    assert.doesNotMatch(joined, /^╭/m, "assistant messages should not use rounded card borders");
  });
  test("renders metadata for a zero timestamp", () => {
    const message = {
      id: "m1",
      role: "assistant",
      provider: "test",
      model: "gpt-test",
      timestamp: 0,
      content: [{ type: "text", text: "Finished." }]
    };
    const component = new AssistantMessageComponent(message, true);
    const joined = component.render(80).map((line) => stripAnsi(line)).join("\n");
    assert.match(joined, new RegExp(formatTimestamp(0)));
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9jb21wb25lbnRzL19fdGVzdHNfXy9hc3Npc3RhbnQtbWVzc2FnZS1kZXNpZ24udGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFZpc3VhbCBjb250cmFjdCB0ZXN0cyBmb3IgdGhlIHJlY29tbWVuZGVkIGluZGVudGVkIGFzc2lzdGFudCBtZXNzYWdlIHJhaWwgZGVzaWduLlxuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHN0cmlwQW5zaSBmcm9tIFwic3RyaXAtYW5zaVwiO1xuaW1wb3J0IHR5cGUgeyBBc3Npc3RhbnRNZXNzYWdlIH0gZnJvbSBcIkBnc2QvcGktYWlcIjtcblxuaW1wb3J0IHsgaW5pdFRoZW1lIH0gZnJvbSBcIi4uLy4uL3RoZW1lL3RoZW1lLmpzXCI7XG5pbXBvcnQgeyBBc3Npc3RhbnRNZXNzYWdlQ29tcG9uZW50IH0gZnJvbSBcIi4uL2Fzc2lzdGFudC1tZXNzYWdlLmpzXCI7XG5pbXBvcnQgeyBmb3JtYXRUaW1lc3RhbXAgfSBmcm9tIFwiLi4vdGltZXN0YW1wLmpzXCI7XG5cbmluaXRUaGVtZShcImRhcmtcIiwgZmFsc2UpO1xuXG5kZXNjcmliZShcIkFzc2lzdGFudE1lc3NhZ2VDb21wb25lbnQgcmVjb21tZW5kZWQgcmFpbCBkZXNpZ25cIiwgKCkgPT4ge1xuXHR0ZXN0KFwicmVuZGVycyBhc3Npc3RhbnQgY29udGVudCB3aXRoIGEgbGlnaHRseSBpbmRlbnRlZCBsZWZ0IHJhaWxcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG1lc3NhZ2UgPSB7XG5cdFx0XHRpZDogXCJtMVwiLFxuXHRcdFx0cm9sZTogXCJhc3Npc3RhbnRcIixcblx0XHRcdHByb3ZpZGVyOiBcInRlc3RcIixcblx0XHRcdG1vZGVsOiBcImdwdC10ZXN0XCIsXG5cdFx0XHR0aW1lc3RhbXA6IDEsXG5cdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJJIHdpbGwgdXBkYXRlIHRoZSByZW5kZXJlciBhbmQgcnVuIHZlcmlmaWNhdGlvbi5cIiB9XSxcblx0XHR9IGFzIHVua25vd24gYXMgQXNzaXN0YW50TWVzc2FnZTtcblxuXHRcdGNvbnN0IGNvbXBvbmVudCA9IG5ldyBBc3Npc3RhbnRNZXNzYWdlQ29tcG9uZW50KG1lc3NhZ2UsIHRydWUpO1xuXHRcdGNvbnN0IHJhdyA9IGNvbXBvbmVudC5yZW5kZXIoODApO1xuXHRcdGNvbnN0IHBsYWluID0gcmF3Lm1hcCgobGluZSkgPT4gc3RyaXBBbnNpKGxpbmUpKTtcblx0XHRjb25zdCBqb2luZWQgPSBwbGFpbi5qb2luKFwiXFxuXCIpO1xuXG5cdFx0YXNzZXJ0Lm9rKHBsYWluLnNvbWUoKGxpbmUpID0+IGxpbmUuc3RhcnRzV2l0aChcIiAgXHUyNTAzIFwiKSksIGBleHBlY3RlZCBpbmRlbnRlZCByYWlsLXByZWZpeGVkIGxpbmVzOlxcbiR7am9pbmVkfWApO1xuXHRcdGFzc2VydC5vayhyYXcuc29tZSgobGluZSkgPT4gbGluZS5pbmNsdWRlcyhcIlxceDFiWzQ4O1wiKSksIGBleHBlY3RlZCBmYWludCBhc3Npc3RhbnQgYmxvY2sgYmFja2dyb3VuZDpcXG4ke3Jhdy5qb2luKFwiXFxuXCIpfWApO1xuXHRcdGFzc2VydC5tYXRjaChqb2luZWQsIC9eXFxzKlx1MjUwM1xccyokL20sIFwiYXNzaXN0YW50IGJsb2NrIHNob3VsZCBpbmNsdWRlIHZlcnRpY2FsIHBhZGRpbmcgcm93c1wiKTtcblx0XHRhc3NlcnQubWF0Y2goam9pbmVkLCAvR1NELyk7XG5cdFx0YXNzZXJ0Lm1hdGNoKGpvaW5lZCwgL2dwdC10ZXN0Lyk7XG5cdFx0YXNzZXJ0Lm1hdGNoKGpvaW5lZCwgL3VwZGF0ZSB0aGUgcmVuZGVyZXIvKTtcblx0XHRhc3NlcnQuZG9lc05vdE1hdGNoKGpvaW5lZCwgL15cdTI1MDMvbSwgXCJhc3Npc3RhbnQgcmFpbCBzaG91bGQgYmUgc2xpZ2h0bHkgaW5kZW50ZWQgZnJvbSB0aGUgbGVmdCBlZGdlXCIpO1xuXHRcdGFzc2VydC5kb2VzTm90TWF0Y2goam9pbmVkLCAvXlx1MjU2RC9tLCBcImFzc2lzdGFudCBtZXNzYWdlcyBzaG91bGQgbm90IHVzZSByb3VuZGVkIGNhcmQgYm9yZGVyc1wiKTtcblx0fSk7XG5cblx0dGVzdChcInJlbmRlcnMgbWV0YWRhdGEgZm9yIGEgemVybyB0aW1lc3RhbXBcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG1lc3NhZ2UgPSB7XG5cdFx0XHRpZDogXCJtMVwiLFxuXHRcdFx0cm9sZTogXCJhc3Npc3RhbnRcIixcblx0XHRcdHByb3ZpZGVyOiBcInRlc3RcIixcblx0XHRcdG1vZGVsOiBcImdwdC10ZXN0XCIsXG5cdFx0XHR0aW1lc3RhbXA6IDAsXG5cdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJGaW5pc2hlZC5cIiB9XSxcblx0XHR9IGFzIHVua25vd24gYXMgQXNzaXN0YW50TWVzc2FnZTtcblxuXHRcdGNvbnN0IGNvbXBvbmVudCA9IG5ldyBBc3Npc3RhbnRNZXNzYWdlQ29tcG9uZW50KG1lc3NhZ2UsIHRydWUpO1xuXHRcdGNvbnN0IGpvaW5lZCA9IGNvbXBvbmVudC5yZW5kZXIoODApLm1hcCgobGluZSkgPT4gc3RyaXBBbnNpKGxpbmUpKS5qb2luKFwiXFxuXCIpO1xuXG5cdFx0YXNzZXJ0Lm1hdGNoKGpvaW5lZCwgbmV3IFJlZ0V4cChmb3JtYXRUaW1lc3RhbXAoMCkpKTtcblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLFNBQVMsVUFBVSxZQUFZO0FBQy9CLE9BQU8sWUFBWTtBQUNuQixPQUFPLGVBQWU7QUFHdEIsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyxpQ0FBaUM7QUFDMUMsU0FBUyx1QkFBdUI7QUFFaEMsVUFBVSxRQUFRLEtBQUs7QUFFdkIsU0FBUyxxREFBcUQsTUFBTTtBQUNuRSxPQUFLLCtEQUErRCxNQUFNO0FBQ3pFLFVBQU0sVUFBVTtBQUFBLE1BQ2YsSUFBSTtBQUFBLE1BQ0osTUFBTTtBQUFBLE1BQ04sVUFBVTtBQUFBLE1BQ1YsT0FBTztBQUFBLE1BQ1AsV0FBVztBQUFBLE1BQ1gsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sbURBQW1ELENBQUM7QUFBQSxJQUNyRjtBQUVBLFVBQU0sWUFBWSxJQUFJLDBCQUEwQixTQUFTLElBQUk7QUFDN0QsVUFBTSxNQUFNLFVBQVUsT0FBTyxFQUFFO0FBQy9CLFVBQU0sUUFBUSxJQUFJLElBQUksQ0FBQyxTQUFTLFVBQVUsSUFBSSxDQUFDO0FBQy9DLFVBQU0sU0FBUyxNQUFNLEtBQUssSUFBSTtBQUU5QixXQUFPLEdBQUcsTUFBTSxLQUFLLENBQUMsU0FBUyxLQUFLLFdBQVcsV0FBTSxDQUFDLEdBQUc7QUFBQSxFQUEyQyxNQUFNLEVBQUU7QUFDNUcsV0FBTyxHQUFHLElBQUksS0FBSyxDQUFDLFNBQVMsS0FBSyxTQUFTLFVBQVUsQ0FBQyxHQUFHO0FBQUEsRUFBK0MsSUFBSSxLQUFLLElBQUksQ0FBQyxFQUFFO0FBQ3hILFdBQU8sTUFBTSxRQUFRLGNBQWMsc0RBQXNEO0FBQ3pGLFdBQU8sTUFBTSxRQUFRLEtBQUs7QUFDMUIsV0FBTyxNQUFNLFFBQVEsVUFBVTtBQUMvQixXQUFPLE1BQU0sUUFBUSxxQkFBcUI7QUFDMUMsV0FBTyxhQUFhLFFBQVEsT0FBTywrREFBK0Q7QUFDbEcsV0FBTyxhQUFhLFFBQVEsT0FBTyx3REFBd0Q7QUFBQSxFQUM1RixDQUFDO0FBRUQsT0FBSyx5Q0FBeUMsTUFBTTtBQUNuRCxVQUFNLFVBQVU7QUFBQSxNQUNmLElBQUk7QUFBQSxNQUNKLE1BQU07QUFBQSxNQUNOLFVBQVU7QUFBQSxNQUNWLE9BQU87QUFBQSxNQUNQLFdBQVc7QUFBQSxNQUNYLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLFlBQVksQ0FBQztBQUFBLElBQzlDO0FBRUEsVUFBTSxZQUFZLElBQUksMEJBQTBCLFNBQVMsSUFBSTtBQUM3RCxVQUFNLFNBQVMsVUFBVSxPQUFPLEVBQUUsRUFBRSxJQUFJLENBQUMsU0FBUyxVQUFVLElBQUksQ0FBQyxFQUFFLEtBQUssSUFBSTtBQUU1RSxXQUFPLE1BQU0sUUFBUSxJQUFJLE9BQU8sZ0JBQWdCLENBQUMsQ0FBQyxDQUFDO0FBQUEsRUFDcEQsQ0FBQztBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
