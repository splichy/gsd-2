import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@gsd/pi-tui";
import {
  padRightVisible,
  renderFrame,
  renderKeyHints,
  renderProgressBar,
  rightAlign,
  safeLine,
  wrapVisibleText
} from "../tui/render-kit.js";
const theme = {
  fg: (_color, text) => text,
  bold: (text) => text
};
function assertWidth(lines, width) {
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `line exceeds width ${width}: ${visibleWidth(line)} "${line}"`
    );
  }
}
describe("tui render kit", () => {
  test("safeLine clamps visible width", () => {
    assert.equal(visibleWidth(safeLine("abcdef", 4)), 4);
    assert.equal(safeLine("abcdef", 0), "");
  });
  test("padRightVisible fills exact visible width", () => {
    const line = padRightVisible("abc", 8);
    assert.equal(visibleWidth(line), 8);
  });
  test("rightAlign keeps output within width", () => {
    for (const width of [10, 40, 80]) {
      assertWidth([rightAlign("left side with overflow", "right side", width)], width);
    }
  });
  test("wrapVisibleText clamps long words and ansi-aware content", () => {
    const lines = wrapVisibleText("https://example.com/" + "a".repeat(120), 24);
    assert.ok(lines.length > 0);
    assertWidth(lines, 24);
  });
  test("renderFrame keeps borders and rows within width", () => {
    for (const width of [3, 40, 80]) {
      assertWidth(renderFrame(theme, ["row", "long ".repeat(40)], width), width);
    }
  });
  test("renderKeyHints and renderProgressBar fit caller budgets", () => {
    assert.ok(visibleWidth(renderKeyHints(theme, ["\u2191\u2193 scroll", "esc close"], 12)) <= 12);
    assert.equal(visibleWidth(renderProgressBar(theme, 2, 4, 16)), 16);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy90dWktcmVuZGVyLWtpdC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogVW5pdCB0ZXN0cyBmb3Igc2hhcmVkIEdTRCBUVUkgcmVuZGVyIGhlbHBlcnMuXG5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5cbmltcG9ydCB7IHZpc2libGVXaWR0aCB9IGZyb20gXCJAZ3NkL3BpLXR1aVwiO1xuaW1wb3J0IHtcbiAgcGFkUmlnaHRWaXNpYmxlLFxuICByZW5kZXJGcmFtZSxcbiAgcmVuZGVyS2V5SGludHMsXG4gIHJlbmRlclByb2dyZXNzQmFyLFxuICByaWdodEFsaWduLFxuICBzYWZlTGluZSxcbiAgd3JhcFZpc2libGVUZXh0LFxuICB0eXBlIFRoZW1lTGlrZSxcbn0gZnJvbSBcIi4uL3R1aS9yZW5kZXIta2l0LnRzXCI7XG5cbmNvbnN0IHRoZW1lOiBUaGVtZUxpa2UgPSB7XG4gIGZnOiAoX2NvbG9yOiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4gdGV4dCxcbiAgYm9sZDogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcbn07XG5cbmZ1bmN0aW9uIGFzc2VydFdpZHRoKGxpbmVzOiBzdHJpbmdbXSwgd2lkdGg6IG51bWJlcik6IHZvaWQge1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcbiAgICBhc3NlcnQub2soXG4gICAgICB2aXNpYmxlV2lkdGgobGluZSkgPD0gd2lkdGgsXG4gICAgICBgbGluZSBleGNlZWRzIHdpZHRoICR7d2lkdGh9OiAke3Zpc2libGVXaWR0aChsaW5lKX0gXCIke2xpbmV9XCJgLFxuICAgICk7XG4gIH1cbn1cblxuZGVzY3JpYmUoXCJ0dWkgcmVuZGVyIGtpdFwiLCAoKSA9PiB7XG4gIHRlc3QoXCJzYWZlTGluZSBjbGFtcHMgdmlzaWJsZSB3aWR0aFwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHZpc2libGVXaWR0aChzYWZlTGluZShcImFiY2RlZlwiLCA0KSksIDQpO1xuICAgIGFzc2VydC5lcXVhbChzYWZlTGluZShcImFiY2RlZlwiLCAwKSwgXCJcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJwYWRSaWdodFZpc2libGUgZmlsbHMgZXhhY3QgdmlzaWJsZSB3aWR0aFwiLCAoKSA9PiB7XG4gICAgY29uc3QgbGluZSA9IHBhZFJpZ2h0VmlzaWJsZShcImFiY1wiLCA4KTtcbiAgICBhc3NlcnQuZXF1YWwodmlzaWJsZVdpZHRoKGxpbmUpLCA4KTtcbiAgfSk7XG5cbiAgdGVzdChcInJpZ2h0QWxpZ24ga2VlcHMgb3V0cHV0IHdpdGhpbiB3aWR0aFwiLCAoKSA9PiB7XG4gICAgZm9yIChjb25zdCB3aWR0aCBvZiBbMTAsIDQwLCA4MF0pIHtcbiAgICAgIGFzc2VydFdpZHRoKFtyaWdodEFsaWduKFwibGVmdCBzaWRlIHdpdGggb3ZlcmZsb3dcIiwgXCJyaWdodCBzaWRlXCIsIHdpZHRoKV0sIHdpZHRoKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJ3cmFwVmlzaWJsZVRleHQgY2xhbXBzIGxvbmcgd29yZHMgYW5kIGFuc2ktYXdhcmUgY29udGVudFwiLCAoKSA9PiB7XG4gICAgY29uc3QgbGluZXMgPSB3cmFwVmlzaWJsZVRleHQoXCJodHRwczovL2V4YW1wbGUuY29tL1wiICsgXCJhXCIucmVwZWF0KDEyMCksIDI0KTtcbiAgICBhc3NlcnQub2sobGluZXMubGVuZ3RoID4gMCk7XG4gICAgYXNzZXJ0V2lkdGgobGluZXMsIDI0KTtcbiAgfSk7XG5cbiAgdGVzdChcInJlbmRlckZyYW1lIGtlZXBzIGJvcmRlcnMgYW5kIHJvd3Mgd2l0aGluIHdpZHRoXCIsICgpID0+IHtcbiAgICBmb3IgKGNvbnN0IHdpZHRoIG9mIFszLCA0MCwgODBdKSB7XG4gICAgICBhc3NlcnRXaWR0aChyZW5kZXJGcmFtZSh0aGVtZSwgW1wicm93XCIsIFwibG9uZyBcIi5yZXBlYXQoNDApXSwgd2lkdGgpLCB3aWR0aCk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwicmVuZGVyS2V5SGludHMgYW5kIHJlbmRlclByb2dyZXNzQmFyIGZpdCBjYWxsZXIgYnVkZ2V0c1wiLCAoKSA9PiB7XG4gICAgYXNzZXJ0Lm9rKHZpc2libGVXaWR0aChyZW5kZXJLZXlIaW50cyh0aGVtZSwgW1wiXHUyMTkxXHUyMTkzIHNjcm9sbFwiLCBcImVzYyBjbG9zZVwiXSwgMTIpKSA8PSAxMik7XG4gICAgYXNzZXJ0LmVxdWFsKHZpc2libGVXaWR0aChyZW5kZXJQcm9ncmVzc0Jhcih0aGVtZSwgMiwgNCwgMTYpKSwgMTYpO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBR0EsU0FBUyxVQUFVLFlBQVk7QUFDL0IsT0FBTyxZQUFZO0FBRW5CLFNBQVMsb0JBQW9CO0FBQzdCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BRUs7QUFFUCxNQUFNLFFBQW1CO0FBQUEsRUFDdkIsSUFBSSxDQUFDLFFBQWdCLFNBQWlCO0FBQUEsRUFDdEMsTUFBTSxDQUFDLFNBQWlCO0FBQzFCO0FBRUEsU0FBUyxZQUFZLE9BQWlCLE9BQXFCO0FBQ3pELGFBQVcsUUFBUSxPQUFPO0FBQ3hCLFdBQU87QUFBQSxNQUNMLGFBQWEsSUFBSSxLQUFLO0FBQUEsTUFDdEIsc0JBQXNCLEtBQUssS0FBSyxhQUFhLElBQUksQ0FBQyxLQUFLLElBQUk7QUFBQSxJQUM3RDtBQUFBLEVBQ0Y7QUFDRjtBQUVBLFNBQVMsa0JBQWtCLE1BQU07QUFDL0IsT0FBSyxpQ0FBaUMsTUFBTTtBQUMxQyxXQUFPLE1BQU0sYUFBYSxTQUFTLFVBQVUsQ0FBQyxDQUFDLEdBQUcsQ0FBQztBQUNuRCxXQUFPLE1BQU0sU0FBUyxVQUFVLENBQUMsR0FBRyxFQUFFO0FBQUEsRUFDeEMsQ0FBQztBQUVELE9BQUssNkNBQTZDLE1BQU07QUFDdEQsVUFBTSxPQUFPLGdCQUFnQixPQUFPLENBQUM7QUFDckMsV0FBTyxNQUFNLGFBQWEsSUFBSSxHQUFHLENBQUM7QUFBQSxFQUNwQyxDQUFDO0FBRUQsT0FBSyx3Q0FBd0MsTUFBTTtBQUNqRCxlQUFXLFNBQVMsQ0FBQyxJQUFJLElBQUksRUFBRSxHQUFHO0FBQ2hDLGtCQUFZLENBQUMsV0FBVywyQkFBMkIsY0FBYyxLQUFLLENBQUMsR0FBRyxLQUFLO0FBQUEsSUFDakY7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLDREQUE0RCxNQUFNO0FBQ3JFLFVBQU0sUUFBUSxnQkFBZ0IseUJBQXlCLElBQUksT0FBTyxHQUFHLEdBQUcsRUFBRTtBQUMxRSxXQUFPLEdBQUcsTUFBTSxTQUFTLENBQUM7QUFDMUIsZ0JBQVksT0FBTyxFQUFFO0FBQUEsRUFDdkIsQ0FBQztBQUVELE9BQUssbURBQW1ELE1BQU07QUFDNUQsZUFBVyxTQUFTLENBQUMsR0FBRyxJQUFJLEVBQUUsR0FBRztBQUMvQixrQkFBWSxZQUFZLE9BQU8sQ0FBQyxPQUFPLFFBQVEsT0FBTyxFQUFFLENBQUMsR0FBRyxLQUFLLEdBQUcsS0FBSztBQUFBLElBQzNFO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSywyREFBMkQsTUFBTTtBQUNwRSxXQUFPLEdBQUcsYUFBYSxlQUFlLE9BQU8sQ0FBQyx1QkFBYSxXQUFXLEdBQUcsRUFBRSxDQUFDLEtBQUssRUFBRTtBQUNuRixXQUFPLE1BQU0sYUFBYSxrQkFBa0IsT0FBTyxHQUFHLEdBQUcsRUFBRSxDQUFDLEdBQUcsRUFBRTtBQUFBLEVBQ25FLENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
