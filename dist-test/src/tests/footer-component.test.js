import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { FooterComponent } from "../../packages/pi-coding-agent/src/modes/interactive/components/footer.js";
import { initTheme } from "../../packages/pi-coding-agent/src/modes/interactive/theme/theme.js";
initTheme("dark", false);
test("FooterComponent renders a rounded operations-console footer with extension statuses", () => {
  const footer = new FooterComponent(
    {
      state: {
        model: { id: "test-model", provider: "test", contextWindow: 1e3 }
      },
      sessionManager: {
        getUsageTotals: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
        getSessionName: () => void 0
      },
      getContextUsage: () => ({ percent: 12.5, contextWindow: 1e3 }),
      getLastTurnCost: () => 0,
      modelRegistry: {
        isUsingOAuth: () => false,
        getProviderAuthMode: () => "apiKey"
      }
    },
    {
      getGitBranch: () => "main",
      getExtensionStatuses: () => /* @__PURE__ */ new Map([["one", "ready"], ["two", "synced"]]),
      getAvailableProviderCount: () => 1
    }
  );
  const lines = footer.render(160).map((line) => stripVTControlCharacters(line));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^╭─+╮$/);
  assert.match(lines[1], /^\│/);
  assert.match(lines[1], /\(main\)/);
  assert.match(lines[1], /ready synced\s*│$/);
  assert.match(lines[1], /● GSD/);
  assert.match(lines[1], /● GSD  │  .* \(main\)  │  /);
  assert.match(lines[1], /12\.5%\/1\.0k/);
  assert.match(lines[2], /^╰─+╯$/);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL2Zvb3Rlci1jb21wb25lbnQudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFJlZ3Jlc3Npb24gdGVzdHMgZm9yIHRoZSBpbnRlcmFjdGl2ZSB0ZXJtaW5hbCBmb290ZXIgcmVuZGVyZXIuXG5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgc3RyaXBWVENvbnRyb2xDaGFyYWN0ZXJzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHsgRm9vdGVyQ29tcG9uZW50IH0gZnJvbSBcIi4uLy4uL3BhY2thZ2VzL3BpLWNvZGluZy1hZ2VudC9zcmMvbW9kZXMvaW50ZXJhY3RpdmUvY29tcG9uZW50cy9mb290ZXIudHNcIjtcbmltcG9ydCB7IGluaXRUaGVtZSB9IGZyb20gXCIuLi8uLi9wYWNrYWdlcy9waS1jb2RpbmctYWdlbnQvc3JjL21vZGVzL2ludGVyYWN0aXZlL3RoZW1lL3RoZW1lLnRzXCI7XG5cbmluaXRUaGVtZShcImRhcmtcIiwgZmFsc2UpO1xuXG50ZXN0KFwiRm9vdGVyQ29tcG9uZW50IHJlbmRlcnMgYSByb3VuZGVkIG9wZXJhdGlvbnMtY29uc29sZSBmb290ZXIgd2l0aCBleHRlbnNpb24gc3RhdHVzZXNcIiwgKCkgPT4ge1xuICBjb25zdCBmb290ZXIgPSBuZXcgRm9vdGVyQ29tcG9uZW50KFxuICAgIHtcbiAgICAgIHN0YXRlOiB7XG4gICAgICAgIG1vZGVsOiB7IGlkOiBcInRlc3QtbW9kZWxcIiwgcHJvdmlkZXI6IFwidGVzdFwiLCBjb250ZXh0V2luZG93OiAxMDAwIH0sXG4gICAgICB9LFxuICAgICAgc2Vzc2lvbk1hbmFnZXI6IHtcbiAgICAgICAgZ2V0VXNhZ2VUb3RhbHM6ICgpID0+ICh7IGlucHV0OiAwLCBvdXRwdXQ6IDAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCwgY29zdDogMCB9KSxcbiAgICAgICAgZ2V0U2Vzc2lvbk5hbWU6ICgpID0+IHVuZGVmaW5lZCxcbiAgICAgIH0sXG4gICAgICBnZXRDb250ZXh0VXNhZ2U6ICgpID0+ICh7IHBlcmNlbnQ6IDEyLjUsIGNvbnRleHRXaW5kb3c6IDEwMDAgfSksXG4gICAgICBnZXRMYXN0VHVybkNvc3Q6ICgpID0+IDAsXG4gICAgICBtb2RlbFJlZ2lzdHJ5OiB7XG4gICAgICAgIGlzVXNpbmdPQXV0aDogKCkgPT4gZmFsc2UsXG4gICAgICAgIGdldFByb3ZpZGVyQXV0aE1vZGU6ICgpID0+IFwiYXBpS2V5XCIsXG4gICAgICB9LFxuICAgIH0gYXMgYW55LFxuICAgIHtcbiAgICAgIGdldEdpdEJyYW5jaDogKCkgPT4gXCJtYWluXCIsXG4gICAgICBnZXRFeHRlbnNpb25TdGF0dXNlczogKCkgPT4gbmV3IE1hcChbW1wib25lXCIsIFwicmVhZHlcIl0sIFtcInR3b1wiLCBcInN5bmNlZFwiXV0pLFxuICAgICAgZ2V0QXZhaWxhYmxlUHJvdmlkZXJDb3VudDogKCkgPT4gMSxcbiAgICB9IGFzIGFueSxcbiAgKTtcblxuICBjb25zdCBsaW5lcyA9IGZvb3Rlci5yZW5kZXIoMTYwKS5tYXAoKGxpbmUpID0+IHN0cmlwVlRDb250cm9sQ2hhcmFjdGVycyhsaW5lKSk7XG5cbiAgYXNzZXJ0LmVxdWFsKGxpbmVzLmxlbmd0aCwgMyk7XG4gIGFzc2VydC5tYXRjaChsaW5lc1swXSwgL15cdTI1NkRcdTI1MDArXHUyNTZFJC8pO1xuICBhc3NlcnQubWF0Y2gobGluZXNbMV0sIC9eXFxcdTI1MDIvKTtcbiAgYXNzZXJ0Lm1hdGNoKGxpbmVzWzFdLCAvXFwobWFpblxcKS8pO1xuICBhc3NlcnQubWF0Y2gobGluZXNbMV0sIC9yZWFkeSBzeW5jZWRcXHMqXHUyNTAyJC8pO1xuICBhc3NlcnQubWF0Y2gobGluZXNbMV0sIC9cdTI1Q0YgR1NELyk7XG4gIGFzc2VydC5tYXRjaChsaW5lc1sxXSwgL1x1MjVDRiBHU0QgIFx1MjUwMiAgLiogXFwobWFpblxcKSAgXHUyNTAyICAvKTtcbiAgYXNzZXJ0Lm1hdGNoKGxpbmVzWzFdLCAvMTJcXC41JVxcLzFcXC4way8pO1xuICBhc3NlcnQubWF0Y2gobGluZXNbMl0sIC9eXHUyNTcwXHUyNTAwK1x1MjU2RiQvKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBR0EsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGdDQUFnQztBQUN6QyxTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLGlCQUFpQjtBQUUxQixVQUFVLFFBQVEsS0FBSztBQUV2QixLQUFLLHVGQUF1RixNQUFNO0FBQ2hHLFFBQU0sU0FBUyxJQUFJO0FBQUEsSUFDakI7QUFBQSxNQUNFLE9BQU87QUFBQSxRQUNMLE9BQU8sRUFBRSxJQUFJLGNBQWMsVUFBVSxRQUFRLGVBQWUsSUFBSztBQUFBLE1BQ25FO0FBQUEsTUFDQSxnQkFBZ0I7QUFBQSxRQUNkLGdCQUFnQixPQUFPLEVBQUUsT0FBTyxHQUFHLFFBQVEsR0FBRyxXQUFXLEdBQUcsWUFBWSxHQUFHLE1BQU0sRUFBRTtBQUFBLFFBQ25GLGdCQUFnQixNQUFNO0FBQUEsTUFDeEI7QUFBQSxNQUNBLGlCQUFpQixPQUFPLEVBQUUsU0FBUyxNQUFNLGVBQWUsSUFBSztBQUFBLE1BQzdELGlCQUFpQixNQUFNO0FBQUEsTUFDdkIsZUFBZTtBQUFBLFFBQ2IsY0FBYyxNQUFNO0FBQUEsUUFDcEIscUJBQXFCLE1BQU07QUFBQSxNQUM3QjtBQUFBLElBQ0Y7QUFBQSxJQUNBO0FBQUEsTUFDRSxjQUFjLE1BQU07QUFBQSxNQUNwQixzQkFBc0IsTUFBTSxvQkFBSSxJQUFJLENBQUMsQ0FBQyxPQUFPLE9BQU8sR0FBRyxDQUFDLE9BQU8sUUFBUSxDQUFDLENBQUM7QUFBQSxNQUN6RSwyQkFBMkIsTUFBTTtBQUFBLElBQ25DO0FBQUEsRUFDRjtBQUVBLFFBQU0sUUFBUSxPQUFPLE9BQU8sR0FBRyxFQUFFLElBQUksQ0FBQyxTQUFTLHlCQUF5QixJQUFJLENBQUM7QUFFN0UsU0FBTyxNQUFNLE1BQU0sUUFBUSxDQUFDO0FBQzVCLFNBQU8sTUFBTSxNQUFNLENBQUMsR0FBRyxRQUFRO0FBQy9CLFNBQU8sTUFBTSxNQUFNLENBQUMsR0FBRyxLQUFLO0FBQzVCLFNBQU8sTUFBTSxNQUFNLENBQUMsR0FBRyxVQUFVO0FBQ2pDLFNBQU8sTUFBTSxNQUFNLENBQUMsR0FBRyxtQkFBbUI7QUFDMUMsU0FBTyxNQUFNLE1BQU0sQ0FBQyxHQUFHLE9BQU87QUFDOUIsU0FBTyxNQUFNLE1BQU0sQ0FBQyxHQUFHLDRCQUE0QjtBQUNuRCxTQUFPLE1BQU0sTUFBTSxDQUFDLEdBQUcsZUFBZTtBQUN0QyxTQUFPLE1BQU0sTUFBTSxDQUFDLEdBQUcsUUFBUTtBQUNqQyxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
