import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { showNextAction } from "../next-action-ui.js";
describe("showNextAction ctx.hasUI guard (#5125 lockup root protection)", () => {
  it("returns 'not_yet' immediately when ctx.hasUI is false (no UI calls)", async () => {
    let customCalled = 0;
    let selectCalled = 0;
    const ctx = {
      hasUI: false,
      ui: {
        custom: async () => {
          customCalled++;
          return void 0;
        },
        select: async () => {
          selectCalled++;
          return void 0;
        }
      }
    };
    const result = await showNextAction(ctx, {
      title: "GSD \u2014 test",
      actions: [
        { id: "a", label: "Option A", description: "first", recommended: true },
        { id: "b", label: "Option B", description: "second" }
      ]
    });
    assert.equal(result, "not_yet", "should short-circuit to safe default");
    assert.equal(customCalled, 0, "ctx.ui.custom must not be called when hasUI is false");
    assert.equal(selectCalled, 0, "ctx.ui.select must not be called when hasUI is false");
  });
  it("uses ctx.ui.select fallback when ctx.hasUI is true and custom returns undefined", async () => {
    let customCalled = 0;
    let selectCalled = 0;
    const ctx = {
      hasUI: true,
      ui: {
        custom: async () => {
          customCalled++;
          return void 0;
        },
        select: async (_title, options) => {
          selectCalled++;
          return options[0];
        }
      }
    };
    const result = await showNextAction(ctx, {
      title: "GSD \u2014 test",
      actions: [
        { id: "alpha", label: "Alpha", description: "first", recommended: true },
        { id: "beta", label: "Beta", description: "second" }
      ]
    });
    assert.equal(customCalled, 1, "ctx.ui.custom must be tried first when hasUI is true");
    assert.equal(selectCalled, 1, "ctx.ui.select must run as fallback when custom returns undefined");
    assert.equal(result, "alpha", "fallback should map the picked label back to the chosen action id");
  });
  it("returns the resolved id when ctx.ui.custom completes normally", async () => {
    let selectCalled = 0;
    const ctx = {
      hasUI: true,
      ui: {
        custom: async (_factory) => {
          return "beta";
        },
        select: async () => {
          selectCalled++;
          return void 0;
        }
      }
    };
    const result = await showNextAction(ctx, {
      title: "GSD \u2014 test",
      actions: [
        { id: "alpha", label: "Alpha", description: "first", recommended: true },
        { id: "beta", label: "Beta", description: "second" }
      ]
    });
    assert.equal(result, "beta", "TUI selection should be returned verbatim");
    assert.equal(selectCalled, 0, "ctx.ui.select fallback must NOT fire when custom returns a value");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3NoYXJlZC90ZXN0cy9uZXh0LWFjdGlvbi11aS1oYXN1aS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QyIFx1MjAxNCBSZWdyZXNzaW9uIHRlc3QgZm9yIG5leHQtYWN0aW9uLXVpIGN0eC5oYXNVSSBzaG9ydC1jaXJjdWl0IChiYXJlIC9nc2QgbG9ja3VwKVxuXG4vKipcbiAqIFJlZ3Jlc3Npb24gdGVzdCBmb3IgdGhlIGJhcmUgL2dzZCBsb2NrdXAgaW52ZXN0aWdhdGVkIGluXG4gKiAucGxhbm5pbmcvcmVwb3J0cy8yMDI2LTA0LTMwLWdzZC1iYXJlLWFuZC1uZXctcHJvamVjdC1pbnZlc3RpZ2F0aW9uLm1kLlxuICpcbiAqIHNob3dOZXh0QWN0aW9uKCkgYXdhaXRzIGN0eC51aS5jdXN0b20oKSB0byByZW5kZXIgYSBUVUkgcHJvbXB0LiBJbiBhXG4gKiBoZWFkbGVzcyBjb250ZXh0IChubyBVSSBib3VuZCwgY3R4Lmhhc1VJID09PSBmYWxzZSksIGJvdGggY3R4LnVpLmN1c3RvbVxuICogYW5kIGN0eC51aS5zZWxlY3QgcmVzb2x2ZSB0byB1bmRlZmluZWQsIGJ1dCB0aGUgY2FsbCBzdGlsbCBwYXlzIGZvciB0d29cbiAqIHNlcXVlbnRpYWwgYXdhaXRzIGJlZm9yZSByZWFjaGluZyB0aGUgc2FmZSBcIm5vdF95ZXRcIiBkZWZhdWx0LiBUaGlzIHRlc3RcbiAqIGFzc2VydHMgdGhlIHByb2FjdGl2ZSBzaG9ydC1jaXJjdWl0OiB3aGVuIGN0eC5oYXNVSSBpcyBmYWxzZSxcbiAqIHNob3dOZXh0QWN0aW9uIHJldHVybnMgXCJub3RfeWV0XCIgaW1tZWRpYXRlbHkgd2l0aG91dCB0b3VjaGluZyBlaXRoZXJcbiAqIFVJIG1ldGhvZC5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcblxuaW1wb3J0IHsgc2hvd05leHRBY3Rpb24gfSBmcm9tIFwiLi4vbmV4dC1hY3Rpb24tdWkuanNcIjtcblxuZGVzY3JpYmUoXCJzaG93TmV4dEFjdGlvbiBjdHguaGFzVUkgZ3VhcmQgKCM1MTI1IGxvY2t1cCByb290IHByb3RlY3Rpb24pXCIsICgpID0+IHtcbiAgaXQoXCJyZXR1cm5zICdub3RfeWV0JyBpbW1lZGlhdGVseSB3aGVuIGN0eC5oYXNVSSBpcyBmYWxzZSAobm8gVUkgY2FsbHMpXCIsIGFzeW5jICgpID0+IHtcbiAgICBsZXQgY3VzdG9tQ2FsbGVkID0gMDtcbiAgICBsZXQgc2VsZWN0Q2FsbGVkID0gMDtcblxuICAgIGNvbnN0IGN0eCA9IHtcbiAgICAgIGhhc1VJOiBmYWxzZSxcbiAgICAgIHVpOiB7XG4gICAgICAgIGN1c3RvbTogYXN5bmMgKCkgPT4ge1xuICAgICAgICAgIGN1c3RvbUNhbGxlZCsrO1xuICAgICAgICAgIHJldHVybiB1bmRlZmluZWQgYXMgbmV2ZXI7XG4gICAgICAgIH0sXG4gICAgICAgIHNlbGVjdDogYXN5bmMgKCkgPT4ge1xuICAgICAgICAgIHNlbGVjdENhbGxlZCsrO1xuICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH07XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBzaG93TmV4dEFjdGlvbihjdHggYXMgYW55LCB7XG4gICAgICB0aXRsZTogXCJHU0QgXHUyMDE0IHRlc3RcIixcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgeyBpZDogXCJhXCIsIGxhYmVsOiBcIk9wdGlvbiBBXCIsIGRlc2NyaXB0aW9uOiBcImZpcnN0XCIsIHJlY29tbWVuZGVkOiB0cnVlIH0sXG4gICAgICAgIHsgaWQ6IFwiYlwiLCBsYWJlbDogXCJPcHRpb24gQlwiLCBkZXNjcmlwdGlvbjogXCJzZWNvbmRcIiB9LFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIFwibm90X3lldFwiLCBcInNob3VsZCBzaG9ydC1jaXJjdWl0IHRvIHNhZmUgZGVmYXVsdFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoY3VzdG9tQ2FsbGVkLCAwLCBcImN0eC51aS5jdXN0b20gbXVzdCBub3QgYmUgY2FsbGVkIHdoZW4gaGFzVUkgaXMgZmFsc2VcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHNlbGVjdENhbGxlZCwgMCwgXCJjdHgudWkuc2VsZWN0IG11c3Qgbm90IGJlIGNhbGxlZCB3aGVuIGhhc1VJIGlzIGZhbHNlXCIpO1xuICB9KTtcblxuICBpdChcInVzZXMgY3R4LnVpLnNlbGVjdCBmYWxsYmFjayB3aGVuIGN0eC5oYXNVSSBpcyB0cnVlIGFuZCBjdXN0b20gcmV0dXJucyB1bmRlZmluZWRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGxldCBjdXN0b21DYWxsZWQgPSAwO1xuICAgIGxldCBzZWxlY3RDYWxsZWQgPSAwO1xuXG4gICAgY29uc3QgY3R4ID0ge1xuICAgICAgaGFzVUk6IHRydWUsXG4gICAgICB1aToge1xuICAgICAgICBjdXN0b206IGFzeW5jICgpID0+IHtcbiAgICAgICAgICBjdXN0b21DYWxsZWQrKztcbiAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkIGFzIG5ldmVyO1xuICAgICAgICB9LFxuICAgICAgICBzZWxlY3Q6IGFzeW5jIChfdGl0bGU6IHN0cmluZywgb3B0aW9uczogc3RyaW5nW10pID0+IHtcbiAgICAgICAgICBzZWxlY3RDYWxsZWQrKztcbiAgICAgICAgICByZXR1cm4gb3B0aW9uc1swXTtcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHNob3dOZXh0QWN0aW9uKGN0eCBhcyBhbnksIHtcbiAgICAgIHRpdGxlOiBcIkdTRCBcdTIwMTQgdGVzdFwiLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICB7IGlkOiBcImFscGhhXCIsIGxhYmVsOiBcIkFscGhhXCIsIGRlc2NyaXB0aW9uOiBcImZpcnN0XCIsIHJlY29tbWVuZGVkOiB0cnVlIH0sXG4gICAgICAgIHsgaWQ6IFwiYmV0YVwiLCBsYWJlbDogXCJCZXRhXCIsIGRlc2NyaXB0aW9uOiBcInNlY29uZFwiIH0sXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKGN1c3RvbUNhbGxlZCwgMSwgXCJjdHgudWkuY3VzdG9tIG11c3QgYmUgdHJpZWQgZmlyc3Qgd2hlbiBoYXNVSSBpcyB0cnVlXCIpO1xuICAgIGFzc2VydC5lcXVhbChzZWxlY3RDYWxsZWQsIDEsIFwiY3R4LnVpLnNlbGVjdCBtdXN0IHJ1biBhcyBmYWxsYmFjayB3aGVuIGN1c3RvbSByZXR1cm5zIHVuZGVmaW5lZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBcImFscGhhXCIsIFwiZmFsbGJhY2sgc2hvdWxkIG1hcCB0aGUgcGlja2VkIGxhYmVsIGJhY2sgdG8gdGhlIGNob3NlbiBhY3Rpb24gaWRcIik7XG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyB0aGUgcmVzb2x2ZWQgaWQgd2hlbiBjdHgudWkuY3VzdG9tIGNvbXBsZXRlcyBub3JtYWxseVwiLCBhc3luYyAoKSA9PiB7XG4gICAgbGV0IHNlbGVjdENhbGxlZCA9IDA7XG5cbiAgICBjb25zdCBjdHggPSB7XG4gICAgICBoYXNVSTogdHJ1ZSxcbiAgICAgIHVpOiB7XG4gICAgICAgIGN1c3RvbTogYXN5bmMgKF9mYWN0b3J5OiBhbnkpID0+IHtcbiAgICAgICAgICAvLyBTaW11bGF0ZSB1c2VyIHNlbGVjdGluZyBhY3Rpb24gXCJiZXRhXCIgdmlhIHRoZSBUVUkgd2lkZ2V0LlxuICAgICAgICAgIHJldHVybiBcImJldGFcIiBhcyBuZXZlcjtcbiAgICAgICAgfSxcbiAgICAgICAgc2VsZWN0OiBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgc2VsZWN0Q2FsbGVkKys7XG4gICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHNob3dOZXh0QWN0aW9uKGN0eCBhcyBhbnksIHtcbiAgICAgIHRpdGxlOiBcIkdTRCBcdTIwMTQgdGVzdFwiLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICB7IGlkOiBcImFscGhhXCIsIGxhYmVsOiBcIkFscGhhXCIsIGRlc2NyaXB0aW9uOiBcImZpcnN0XCIsIHJlY29tbWVuZGVkOiB0cnVlIH0sXG4gICAgICAgIHsgaWQ6IFwiYmV0YVwiLCBsYWJlbDogXCJCZXRhXCIsIGRlc2NyaXB0aW9uOiBcInNlY29uZFwiIH0sXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJiZXRhXCIsIFwiVFVJIHNlbGVjdGlvbiBzaG91bGQgYmUgcmV0dXJuZWQgdmVyYmF0aW1cIik7XG4gICAgYXNzZXJ0LmVxdWFsKHNlbGVjdENhbGxlZCwgMCwgXCJjdHgudWkuc2VsZWN0IGZhbGxiYWNrIG11c3QgTk9UIGZpcmUgd2hlbiBjdXN0b20gcmV0dXJucyBhIHZhbHVlXCIpO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBZUEsU0FBUyxVQUFVLFVBQVU7QUFDN0IsT0FBTyxZQUFZO0FBRW5CLFNBQVMsc0JBQXNCO0FBRS9CLFNBQVMsaUVBQWlFLE1BQU07QUFDOUUsS0FBRyx1RUFBdUUsWUFBWTtBQUNwRixRQUFJLGVBQWU7QUFDbkIsUUFBSSxlQUFlO0FBRW5CLFVBQU0sTUFBTTtBQUFBLE1BQ1YsT0FBTztBQUFBLE1BQ1AsSUFBSTtBQUFBLFFBQ0YsUUFBUSxZQUFZO0FBQ2xCO0FBQ0EsaUJBQU87QUFBQSxRQUNUO0FBQUEsUUFDQSxRQUFRLFlBQVk7QUFDbEI7QUFDQSxpQkFBTztBQUFBLFFBQ1Q7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUVBLFVBQU0sU0FBUyxNQUFNLGVBQWUsS0FBWTtBQUFBLE1BQzlDLE9BQU87QUFBQSxNQUNQLFNBQVM7QUFBQSxRQUNQLEVBQUUsSUFBSSxLQUFLLE9BQU8sWUFBWSxhQUFhLFNBQVMsYUFBYSxLQUFLO0FBQUEsUUFDdEUsRUFBRSxJQUFJLEtBQUssT0FBTyxZQUFZLGFBQWEsU0FBUztBQUFBLE1BQ3REO0FBQUEsSUFDRixDQUFDO0FBRUQsV0FBTyxNQUFNLFFBQVEsV0FBVyxzQ0FBc0M7QUFDdEUsV0FBTyxNQUFNLGNBQWMsR0FBRyxzREFBc0Q7QUFDcEYsV0FBTyxNQUFNLGNBQWMsR0FBRyxzREFBc0Q7QUFBQSxFQUN0RixDQUFDO0FBRUQsS0FBRyxtRkFBbUYsWUFBWTtBQUNoRyxRQUFJLGVBQWU7QUFDbkIsUUFBSSxlQUFlO0FBRW5CLFVBQU0sTUFBTTtBQUFBLE1BQ1YsT0FBTztBQUFBLE1BQ1AsSUFBSTtBQUFBLFFBQ0YsUUFBUSxZQUFZO0FBQ2xCO0FBQ0EsaUJBQU87QUFBQSxRQUNUO0FBQUEsUUFDQSxRQUFRLE9BQU8sUUFBZ0IsWUFBc0I7QUFDbkQ7QUFDQSxpQkFBTyxRQUFRLENBQUM7QUFBQSxRQUNsQjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBRUEsVUFBTSxTQUFTLE1BQU0sZUFBZSxLQUFZO0FBQUEsTUFDOUMsT0FBTztBQUFBLE1BQ1AsU0FBUztBQUFBLFFBQ1AsRUFBRSxJQUFJLFNBQVMsT0FBTyxTQUFTLGFBQWEsU0FBUyxhQUFhLEtBQUs7QUFBQSxRQUN2RSxFQUFFLElBQUksUUFBUSxPQUFPLFFBQVEsYUFBYSxTQUFTO0FBQUEsTUFDckQ7QUFBQSxJQUNGLENBQUM7QUFFRCxXQUFPLE1BQU0sY0FBYyxHQUFHLHNEQUFzRDtBQUNwRixXQUFPLE1BQU0sY0FBYyxHQUFHLGtFQUFrRTtBQUNoRyxXQUFPLE1BQU0sUUFBUSxTQUFTLG1FQUFtRTtBQUFBLEVBQ25HLENBQUM7QUFFRCxLQUFHLGlFQUFpRSxZQUFZO0FBQzlFLFFBQUksZUFBZTtBQUVuQixVQUFNLE1BQU07QUFBQSxNQUNWLE9BQU87QUFBQSxNQUNQLElBQUk7QUFBQSxRQUNGLFFBQVEsT0FBTyxhQUFrQjtBQUUvQixpQkFBTztBQUFBLFFBQ1Q7QUFBQSxRQUNBLFFBQVEsWUFBWTtBQUNsQjtBQUNBLGlCQUFPO0FBQUEsUUFDVDtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBRUEsVUFBTSxTQUFTLE1BQU0sZUFBZSxLQUFZO0FBQUEsTUFDOUMsT0FBTztBQUFBLE1BQ1AsU0FBUztBQUFBLFFBQ1AsRUFBRSxJQUFJLFNBQVMsT0FBTyxTQUFTLGFBQWEsU0FBUyxhQUFhLEtBQUs7QUFBQSxRQUN2RSxFQUFFLElBQUksUUFBUSxPQUFPLFFBQVEsYUFBYSxTQUFTO0FBQUEsTUFDckQ7QUFBQSxJQUNGLENBQUM7QUFFRCxXQUFPLE1BQU0sUUFBUSxRQUFRLDJDQUEyQztBQUN4RSxXQUFPLE1BQU0sY0FBYyxHQUFHLGtFQUFrRTtBQUFBLEVBQ2xHLENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
