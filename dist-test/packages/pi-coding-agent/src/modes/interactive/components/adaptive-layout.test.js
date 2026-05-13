import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import stripAnsi from "strip-ansi";
import { AdaptiveLayoutComponent } from "./adaptive-layout.js";
import { initTheme } from "../theme/theme.js";
before(() => {
  initTheme("dark", false);
});
function render(component, width) {
  return component.render(width).map(stripAnsi).join("\n");
}
describe("AdaptiveLayoutComponent", () => {
  it("renders a rounded workflow command center on wide terminals", () => {
    const component = new AdaptiveLayoutComponent(() => ({
      override: "workflow",
      activeToolCount: 2,
      gsdPhase: "executing milestone M001",
      sessionName: "demo",
      cwd: "/tmp/demo"
    }));
    const output = render(component, 132);
    assert.match(output, /GSD Command Center/);
    assert.match(output, /workflow · ready/);
    assert.match(output, /2 running/);
    assert.match(output, /watch tool output/);
    assert.doesNotMatch(output, /signals/);
    assert.doesNotMatch(output, /inspector/);
    assert.doesNotMatch(output, /\bauto\b/i);
    assert.match(output, /^╭─+╮/m);
  });
  it("falls back to a single compact row for narrow workflow terminals", () => {
    const component = new AdaptiveLayoutComponent(() => ({
      override: "workflow",
      activeToolCount: 1,
      gsdPhase: "executing milestone M001",
      cwd: "/tmp/demo"
    }));
    const output = render(component, 68);
    assert.match(output, /GSD compact/);
    assert.doesNotMatch(output, /signals/);
    assert.doesNotMatch(output, /\bauto\b/i);
  });
  it("renders blocking failure context in debug mode", () => {
    const component = new AdaptiveLayoutComponent(() => ({
      override: "auto",
      activeToolCount: 0,
      lastError: "Cannot find module @gsd/native",
      cwd: "/tmp/demo"
    }));
    const output = render(component, 120);
    assert.match(output, /blocking failure/);
    assert.match(output, /Cannot find module/);
    assert.match(output, /inspect the failed output/);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9jb21wb25lbnRzL2FkYXB0aXZlLWxheW91dC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogUnVudGltZSB0ZXN0cyBmb3IgYWRhcHRpdmUgY29tbWFuZC1jZW50ZXIgdGVybWluYWwgbGF5b3V0IHJlbmRlcmluZy5cblxuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBkZXNjcmliZSwgaXQsIGJlZm9yZSB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBzdHJpcEFuc2kgZnJvbSBcInN0cmlwLWFuc2lcIjtcbmltcG9ydCB7IEFkYXB0aXZlTGF5b3V0Q29tcG9uZW50IH0gZnJvbSBcIi4vYWRhcHRpdmUtbGF5b3V0LmpzXCI7XG5pbXBvcnQgeyBpbml0VGhlbWUgfSBmcm9tIFwiLi4vdGhlbWUvdGhlbWUuanNcIjtcblxuYmVmb3JlKCgpID0+IHtcblx0aW5pdFRoZW1lKFwiZGFya1wiLCBmYWxzZSk7XG59KTtcblxuZnVuY3Rpb24gcmVuZGVyKGNvbXBvbmVudDogQWRhcHRpdmVMYXlvdXRDb21wb25lbnQsIHdpZHRoOiBudW1iZXIpOiBzdHJpbmcge1xuXHRyZXR1cm4gY29tcG9uZW50LnJlbmRlcih3aWR0aCkubWFwKHN0cmlwQW5zaSkuam9pbihcIlxcblwiKTtcbn1cblxuZGVzY3JpYmUoXCJBZGFwdGl2ZUxheW91dENvbXBvbmVudFwiLCAoKSA9PiB7XG5cdGl0KFwicmVuZGVycyBhIHJvdW5kZWQgd29ya2Zsb3cgY29tbWFuZCBjZW50ZXIgb24gd2lkZSB0ZXJtaW5hbHNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGNvbXBvbmVudCA9IG5ldyBBZGFwdGl2ZUxheW91dENvbXBvbmVudCgoKSA9PiAoe1xuXHRcdFx0b3ZlcnJpZGU6IFwid29ya2Zsb3dcIixcblx0XHRcdGFjdGl2ZVRvb2xDb3VudDogMixcblx0XHRcdGdzZFBoYXNlOiBcImV4ZWN1dGluZyBtaWxlc3RvbmUgTTAwMVwiLFxuXHRcdFx0c2Vzc2lvbk5hbWU6IFwiZGVtb1wiLFxuXHRcdFx0Y3dkOiBcIi90bXAvZGVtb1wiLFxuXHRcdH0pKTtcblxuXHRcdGNvbnN0IG91dHB1dCA9IHJlbmRlcihjb21wb25lbnQsIDEzMik7XG5cdFx0YXNzZXJ0Lm1hdGNoKG91dHB1dCwgL0dTRCBDb21tYW5kIENlbnRlci8pO1xuXHRcdGFzc2VydC5tYXRjaChvdXRwdXQsIC93b3JrZmxvdyBcdTAwQjcgcmVhZHkvKTtcblx0XHRhc3NlcnQubWF0Y2gob3V0cHV0LCAvMiBydW5uaW5nLyk7XG5cdFx0YXNzZXJ0Lm1hdGNoKG91dHB1dCwgL3dhdGNoIHRvb2wgb3V0cHV0Lyk7XG5cdFx0YXNzZXJ0LmRvZXNOb3RNYXRjaChvdXRwdXQsIC9zaWduYWxzLyk7XG5cdFx0YXNzZXJ0LmRvZXNOb3RNYXRjaChvdXRwdXQsIC9pbnNwZWN0b3IvKTtcblx0XHRhc3NlcnQuZG9lc05vdE1hdGNoKG91dHB1dCwgL1xcYmF1dG9cXGIvaSk7XG5cdFx0YXNzZXJ0Lm1hdGNoKG91dHB1dCwgL15cdTI1NkRcdTI1MDArXHUyNTZFL20pO1xuXHR9KTtcblxuXHRpdChcImZhbGxzIGJhY2sgdG8gYSBzaW5nbGUgY29tcGFjdCByb3cgZm9yIG5hcnJvdyB3b3JrZmxvdyB0ZXJtaW5hbHNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGNvbXBvbmVudCA9IG5ldyBBZGFwdGl2ZUxheW91dENvbXBvbmVudCgoKSA9PiAoe1xuXHRcdFx0b3ZlcnJpZGU6IFwid29ya2Zsb3dcIixcblx0XHRcdGFjdGl2ZVRvb2xDb3VudDogMSxcblx0XHRcdGdzZFBoYXNlOiBcImV4ZWN1dGluZyBtaWxlc3RvbmUgTTAwMVwiLFxuXHRcdFx0Y3dkOiBcIi90bXAvZGVtb1wiLFxuXHRcdH0pKTtcblxuXHRcdGNvbnN0IG91dHB1dCA9IHJlbmRlcihjb21wb25lbnQsIDY4KTtcblx0XHRhc3NlcnQubWF0Y2gob3V0cHV0LCAvR1NEIGNvbXBhY3QvKTtcblx0XHRhc3NlcnQuZG9lc05vdE1hdGNoKG91dHB1dCwgL3NpZ25hbHMvKTtcblx0XHRhc3NlcnQuZG9lc05vdE1hdGNoKG91dHB1dCwgL1xcYmF1dG9cXGIvaSk7XG5cdH0pO1xuXG5cdGl0KFwicmVuZGVycyBibG9ja2luZyBmYWlsdXJlIGNvbnRleHQgaW4gZGVidWcgbW9kZVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY29tcG9uZW50ID0gbmV3IEFkYXB0aXZlTGF5b3V0Q29tcG9uZW50KCgpID0+ICh7XG5cdFx0XHRvdmVycmlkZTogXCJhdXRvXCIsXG5cdFx0XHRhY3RpdmVUb29sQ291bnQ6IDAsXG5cdFx0XHRsYXN0RXJyb3I6IFwiQ2Fubm90IGZpbmQgbW9kdWxlIEBnc2QvbmF0aXZlXCIsXG5cdFx0XHRjd2Q6IFwiL3RtcC9kZW1vXCIsXG5cdFx0fSkpO1xuXG5cdFx0Y29uc3Qgb3V0cHV0ID0gcmVuZGVyKGNvbXBvbmVudCwgMTIwKTtcblx0XHRhc3NlcnQubWF0Y2gob3V0cHV0LCAvYmxvY2tpbmcgZmFpbHVyZS8pO1xuXHRcdGFzc2VydC5tYXRjaChvdXRwdXQsIC9DYW5ub3QgZmluZCBtb2R1bGUvKTtcblx0XHRhc3NlcnQubWF0Y2gob3V0cHV0LCAvaW5zcGVjdCB0aGUgZmFpbGVkIG91dHB1dC8pO1xuXHR9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBR0EsT0FBTyxZQUFZO0FBQ25CLFNBQVMsVUFBVSxJQUFJLGNBQWM7QUFDckMsT0FBTyxlQUFlO0FBQ3RCLFNBQVMsK0JBQStCO0FBQ3hDLFNBQVMsaUJBQWlCO0FBRTFCLE9BQU8sTUFBTTtBQUNaLFlBQVUsUUFBUSxLQUFLO0FBQ3hCLENBQUM7QUFFRCxTQUFTLE9BQU8sV0FBb0MsT0FBdUI7QUFDMUUsU0FBTyxVQUFVLE9BQU8sS0FBSyxFQUFFLElBQUksU0FBUyxFQUFFLEtBQUssSUFBSTtBQUN4RDtBQUVBLFNBQVMsMkJBQTJCLE1BQU07QUFDekMsS0FBRywrREFBK0QsTUFBTTtBQUN2RSxVQUFNLFlBQVksSUFBSSx3QkFBd0IsT0FBTztBQUFBLE1BQ3BELFVBQVU7QUFBQSxNQUNWLGlCQUFpQjtBQUFBLE1BQ2pCLFVBQVU7QUFBQSxNQUNWLGFBQWE7QUFBQSxNQUNiLEtBQUs7QUFBQSxJQUNOLEVBQUU7QUFFRixVQUFNLFNBQVMsT0FBTyxXQUFXLEdBQUc7QUFDcEMsV0FBTyxNQUFNLFFBQVEsb0JBQW9CO0FBQ3pDLFdBQU8sTUFBTSxRQUFRLGtCQUFrQjtBQUN2QyxXQUFPLE1BQU0sUUFBUSxXQUFXO0FBQ2hDLFdBQU8sTUFBTSxRQUFRLG1CQUFtQjtBQUN4QyxXQUFPLGFBQWEsUUFBUSxTQUFTO0FBQ3JDLFdBQU8sYUFBYSxRQUFRLFdBQVc7QUFDdkMsV0FBTyxhQUFhLFFBQVEsV0FBVztBQUN2QyxXQUFPLE1BQU0sUUFBUSxRQUFRO0FBQUEsRUFDOUIsQ0FBQztBQUVELEtBQUcsb0VBQW9FLE1BQU07QUFDNUUsVUFBTSxZQUFZLElBQUksd0JBQXdCLE9BQU87QUFBQSxNQUNwRCxVQUFVO0FBQUEsTUFDVixpQkFBaUI7QUFBQSxNQUNqQixVQUFVO0FBQUEsTUFDVixLQUFLO0FBQUEsSUFDTixFQUFFO0FBRUYsVUFBTSxTQUFTLE9BQU8sV0FBVyxFQUFFO0FBQ25DLFdBQU8sTUFBTSxRQUFRLGFBQWE7QUFDbEMsV0FBTyxhQUFhLFFBQVEsU0FBUztBQUNyQyxXQUFPLGFBQWEsUUFBUSxXQUFXO0FBQUEsRUFDeEMsQ0FBQztBQUVELEtBQUcsa0RBQWtELE1BQU07QUFDMUQsVUFBTSxZQUFZLElBQUksd0JBQXdCLE9BQU87QUFBQSxNQUNwRCxVQUFVO0FBQUEsTUFDVixpQkFBaUI7QUFBQSxNQUNqQixXQUFXO0FBQUEsTUFDWCxLQUFLO0FBQUEsSUFDTixFQUFFO0FBRUYsVUFBTSxTQUFTLE9BQU8sV0FBVyxHQUFHO0FBQ3BDLFdBQU8sTUFBTSxRQUFRLGtCQUFrQjtBQUN2QyxXQUFPLE1BQU0sUUFBUSxvQkFBb0I7QUFDekMsV0FBTyxNQUFNLFFBQVEsMkJBQTJCO0FBQUEsRUFDakQsQ0FBQztBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
