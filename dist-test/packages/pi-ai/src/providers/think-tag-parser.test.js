import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ThinkTagParser } from "./think-tag-parser.js";
describe("ThinkTagParser", () => {
  it("keeps plain text untouched", () => {
    const parser = new ThinkTagParser();
    assert.deepEqual(parser.consume("hello world"), [{ type: "text", text: "hello world" }]);
    assert.deepEqual(parser.flush(), []);
  });
  it("splits inline think tags into thinking segments", () => {
    const parser = new ThinkTagParser();
    const out = parser.consume("A<think>B</think>C");
    assert.deepEqual(out, [
      { type: "text", text: "A" },
      { type: "thinking", text: "B" },
      { type: "text", text: "C" }
    ]);
  });
  it("handles tag boundaries across deltas", () => {
    const parser = new ThinkTagParser();
    const out1 = parser.consume("A<th");
    const out2 = parser.consume("ink>B</thi");
    const out3 = parser.consume("nk>C");
    const out4 = parser.flush();
    assert.deepEqual([...out1, ...out2, ...out3, ...out4], [
      { type: "text", text: "A" },
      { type: "thinking", text: "B" },
      { type: "text", text: "C" }
    ]);
  });
  it("flushes unclosed think blocks as thinking", () => {
    const parser = new ThinkTagParser();
    const out1 = parser.consume("A<think>partial");
    const out2 = parser.flush();
    assert.deepEqual([...out1, ...out2], [
      { type: "text", text: "A" },
      { type: "thinking", text: "partial" }
    ]);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL3Byb3ZpZGVycy90aGluay10YWctcGFyc2VyLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgZGVzY3JpYmUsIGl0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IHsgVGhpbmtUYWdQYXJzZXIgfSBmcm9tIFwiLi90aGluay10YWctcGFyc2VyLmpzXCI7XG5cbmRlc2NyaWJlKFwiVGhpbmtUYWdQYXJzZXJcIiwgKCkgPT4ge1xuXHRpdChcImtlZXBzIHBsYWluIHRleHQgdW50b3VjaGVkXCIsICgpID0+IHtcblx0XHRjb25zdCBwYXJzZXIgPSBuZXcgVGhpbmtUYWdQYXJzZXIoKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHBhcnNlci5jb25zdW1lKFwiaGVsbG8gd29ybGRcIiksIFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcImhlbGxvIHdvcmxkXCIgfV0pO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwocGFyc2VyLmZsdXNoKCksIFtdKTtcblx0fSk7XG5cblx0aXQoXCJzcGxpdHMgaW5saW5lIHRoaW5rIHRhZ3MgaW50byB0aGlua2luZyBzZWdtZW50c1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcGFyc2VyID0gbmV3IFRoaW5rVGFnUGFyc2VyKCk7XG5cdFx0Y29uc3Qgb3V0ID0gcGFyc2VyLmNvbnN1bWUoXCJBPHRoaW5rPkI8L3RoaW5rPkNcIik7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChvdXQsIFtcblx0XHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiQVwiIH0sXG5cdFx0XHR7IHR5cGU6IFwidGhpbmtpbmdcIiwgdGV4dDogXCJCXCIgfSxcblx0XHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiQ1wiIH0sXG5cdFx0XSk7XG5cdH0pO1xuXG5cdGl0KFwiaGFuZGxlcyB0YWcgYm91bmRhcmllcyBhY3Jvc3MgZGVsdGFzXCIsICgpID0+IHtcblx0XHRjb25zdCBwYXJzZXIgPSBuZXcgVGhpbmtUYWdQYXJzZXIoKTtcblx0XHRjb25zdCBvdXQxID0gcGFyc2VyLmNvbnN1bWUoXCJBPHRoXCIpO1xuXHRcdGNvbnN0IG91dDIgPSBwYXJzZXIuY29uc3VtZShcImluaz5CPC90aGlcIik7XG5cdFx0Y29uc3Qgb3V0MyA9IHBhcnNlci5jb25zdW1lKFwibms+Q1wiKTtcblx0XHRjb25zdCBvdXQ0ID0gcGFyc2VyLmZsdXNoKCk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChbLi4ub3V0MSwgLi4ub3V0MiwgLi4ub3V0MywgLi4ub3V0NF0sIFtcblx0XHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiQVwiIH0sXG5cdFx0XHR7IHR5cGU6IFwidGhpbmtpbmdcIiwgdGV4dDogXCJCXCIgfSxcblx0XHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiQ1wiIH0sXG5cdFx0XSk7XG5cdH0pO1xuXG5cdGl0KFwiZmx1c2hlcyB1bmNsb3NlZCB0aGluayBibG9ja3MgYXMgdGhpbmtpbmdcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHBhcnNlciA9IG5ldyBUaGlua1RhZ1BhcnNlcigpO1xuXHRcdGNvbnN0IG91dDEgPSBwYXJzZXIuY29uc3VtZShcIkE8dGhpbms+cGFydGlhbFwiKTtcblx0XHRjb25zdCBvdXQyID0gcGFyc2VyLmZsdXNoKCk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChbLi4ub3V0MSwgLi4ub3V0Ml0sIFtcblx0XHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiQVwiIH0sXG5cdFx0XHR7IHR5cGU6IFwidGhpbmtpbmdcIiwgdGV4dDogXCJwYXJ0aWFsXCIgfSxcblx0XHRdKTtcblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sWUFBWTtBQUNuQixTQUFTLFVBQVUsVUFBVTtBQUM3QixTQUFTLHNCQUFzQjtBQUUvQixTQUFTLGtCQUFrQixNQUFNO0FBQ2hDLEtBQUcsOEJBQThCLE1BQU07QUFDdEMsVUFBTSxTQUFTLElBQUksZUFBZTtBQUNsQyxXQUFPLFVBQVUsT0FBTyxRQUFRLGFBQWEsR0FBRyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sY0FBYyxDQUFDLENBQUM7QUFDdkYsV0FBTyxVQUFVLE9BQU8sTUFBTSxHQUFHLENBQUMsQ0FBQztBQUFBLEVBQ3BDLENBQUM7QUFFRCxLQUFHLG1EQUFtRCxNQUFNO0FBQzNELFVBQU0sU0FBUyxJQUFJLGVBQWU7QUFDbEMsVUFBTSxNQUFNLE9BQU8sUUFBUSxvQkFBb0I7QUFDL0MsV0FBTyxVQUFVLEtBQUs7QUFBQSxNQUNyQixFQUFFLE1BQU0sUUFBUSxNQUFNLElBQUk7QUFBQSxNQUMxQixFQUFFLE1BQU0sWUFBWSxNQUFNLElBQUk7QUFBQSxNQUM5QixFQUFFLE1BQU0sUUFBUSxNQUFNLElBQUk7QUFBQSxJQUMzQixDQUFDO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyx3Q0FBd0MsTUFBTTtBQUNoRCxVQUFNLFNBQVMsSUFBSSxlQUFlO0FBQ2xDLFVBQU0sT0FBTyxPQUFPLFFBQVEsTUFBTTtBQUNsQyxVQUFNLE9BQU8sT0FBTyxRQUFRLFlBQVk7QUFDeEMsVUFBTSxPQUFPLE9BQU8sUUFBUSxNQUFNO0FBQ2xDLFVBQU0sT0FBTyxPQUFPLE1BQU07QUFDMUIsV0FBTyxVQUFVLENBQUMsR0FBRyxNQUFNLEdBQUcsTUFBTSxHQUFHLE1BQU0sR0FBRyxJQUFJLEdBQUc7QUFBQSxNQUN0RCxFQUFFLE1BQU0sUUFBUSxNQUFNLElBQUk7QUFBQSxNQUMxQixFQUFFLE1BQU0sWUFBWSxNQUFNLElBQUk7QUFBQSxNQUM5QixFQUFFLE1BQU0sUUFBUSxNQUFNLElBQUk7QUFBQSxJQUMzQixDQUFDO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyw2Q0FBNkMsTUFBTTtBQUNyRCxVQUFNLFNBQVMsSUFBSSxlQUFlO0FBQ2xDLFVBQU0sT0FBTyxPQUFPLFFBQVEsaUJBQWlCO0FBQzdDLFVBQU0sT0FBTyxPQUFPLE1BQU07QUFDMUIsV0FBTyxVQUFVLENBQUMsR0FBRyxNQUFNLEdBQUcsSUFBSSxHQUFHO0FBQUEsTUFDcEMsRUFBRSxNQUFNLFFBQVEsTUFBTSxJQUFJO0FBQUEsTUFDMUIsRUFBRSxNQUFNLFlBQVksTUFBTSxVQUFVO0FBQUEsSUFDckMsQ0FBQztBQUFBLEVBQ0YsQ0FBQztBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
