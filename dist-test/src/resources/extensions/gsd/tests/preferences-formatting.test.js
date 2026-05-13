import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatSkillRef } from "../preferences-types.js";
function makeResolutions(entries) {
  const map = /* @__PURE__ */ new Map();
  for (const [key, partial] of entries) {
    map.set(key, {
      original: partial.original ?? key,
      resolvedPath: partial.resolvedPath ?? null,
      method: partial.method ?? "unresolved"
    });
  }
  return map;
}
describe("formatSkillRef", () => {
  test("marks unresolved references with a warning", () => {
    const resolutions = makeResolutions([
      ["my-skill", { method: "unresolved" }]
    ]);
    const result = formatSkillRef("my-skill", resolutions);
    assert.match(result, /my-skill/);
    assert.match(result, /not found/);
  });
  test("marks unknown references (not in map) with a warning", () => {
    const resolutions = /* @__PURE__ */ new Map();
    const result = formatSkillRef("unknown-skill", resolutions);
    assert.match(result, /unknown-skill/);
    assert.match(result, /not found/);
  });
  test("returns bare ref for absolute-path resolution", () => {
    const resolutions = makeResolutions([
      ["/home/user/skills/SKILL.md", {
        method: "absolute-path",
        resolvedPath: "/home/user/skills/SKILL.md"
      }]
    ]);
    const result = formatSkillRef("/home/user/skills/SKILL.md", resolutions);
    assert.equal(result, "/home/user/skills/SKILL.md");
  });
  test("returns bare ref for absolute-dir resolution", () => {
    const resolutions = makeResolutions([
      ["/home/user/skills/my-skill", {
        method: "absolute-dir",
        resolvedPath: "/home/user/skills/my-skill/SKILL.md"
      }]
    ]);
    const result = formatSkillRef("/home/user/skills/my-skill", resolutions);
    assert.equal(result, "/home/user/skills/my-skill");
  });
  test("shows resolved path for user-skill resolution", () => {
    const resolutions = makeResolutions([
      ["code-review", {
        method: "user-skill",
        resolvedPath: "/home/user/.claude/skills/code-review/SKILL.md"
      }]
    ]);
    const result = formatSkillRef("code-review", resolutions);
    assert.match(result, /code-review/);
    assert.match(result, /\.claude\/skills\/code-review\/SKILL\.md/);
  });
  test("shows resolved path for project-skill resolution", () => {
    const resolutions = makeResolutions([
      ["lint-fix", {
        method: "project-skill",
        resolvedPath: "/repo/.gsd/skills/lint-fix/SKILL.md"
      }]
    ]);
    const result = formatSkillRef("lint-fix", resolutions);
    assert.match(result, /lint-fix/);
    assert.match(result, /\.gsd\/skills\/lint-fix\/SKILL\.md/);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wcmVmZXJlbmNlcy1mb3JtYXR0aW5nLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogVGVzdHMgZm9yIGZvcm1hdFNraWxsUmVmIFx1MjAxNCBwdXJlIGZvcm1hdHRpbmcgbG9naWMgZm9yIHNraWxsIHJlZmVyZW5jZXNcbiAqIGluIHRoZSBzeXN0ZW0gcHJvbXB0LiBNb3ZlZCBmcm9tIHByZWZlcmVuY2VzLXNraWxscy50cyB0byBwcmVmZXJlbmNlcy10eXBlcy50c1xuICogdG8gYnJlYWsgdGhlIHByZWZlcmVuY2VzIFx1MjE5NCBwcmVmZXJlbmNlcy1za2lsbHMgY2lyY3VsYXIgZGVwZW5kZW5jeS5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuXG5pbXBvcnQgeyBmb3JtYXRTa2lsbFJlZiB9IGZyb20gXCIuLi9wcmVmZXJlbmNlcy10eXBlcy50c1wiO1xuaW1wb3J0IHR5cGUgeyBTa2lsbFJlc29sdXRpb24gfSBmcm9tIFwiLi4vcHJlZmVyZW5jZXMtdHlwZXMudHNcIjtcblxuZnVuY3Rpb24gbWFrZVJlc29sdXRpb25zKGVudHJpZXM6IFtzdHJpbmcsIFBhcnRpYWw8U2tpbGxSZXNvbHV0aW9uPl1bXSk6IE1hcDxzdHJpbmcsIFNraWxsUmVzb2x1dGlvbj4ge1xuICBjb25zdCBtYXAgPSBuZXcgTWFwPHN0cmluZywgU2tpbGxSZXNvbHV0aW9uPigpO1xuICBmb3IgKGNvbnN0IFtrZXksIHBhcnRpYWxdIG9mIGVudHJpZXMpIHtcbiAgICBtYXAuc2V0KGtleSwge1xuICAgICAgb3JpZ2luYWw6IHBhcnRpYWwub3JpZ2luYWwgPz8ga2V5LFxuICAgICAgcmVzb2x2ZWRQYXRoOiBwYXJ0aWFsLnJlc29sdmVkUGF0aCA/PyBudWxsLFxuICAgICAgbWV0aG9kOiBwYXJ0aWFsLm1ldGhvZCA/PyBcInVucmVzb2x2ZWRcIixcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gbWFwO1xufVxuXG5kZXNjcmliZShcImZvcm1hdFNraWxsUmVmXCIsICgpID0+IHtcbiAgdGVzdChcIm1hcmtzIHVucmVzb2x2ZWQgcmVmZXJlbmNlcyB3aXRoIGEgd2FybmluZ1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzb2x1dGlvbnMgPSBtYWtlUmVzb2x1dGlvbnMoW1xuICAgICAgW1wibXktc2tpbGxcIiwgeyBtZXRob2Q6IFwidW5yZXNvbHZlZFwiIH1dLFxuICAgIF0pO1xuICAgIGNvbnN0IHJlc3VsdCA9IGZvcm1hdFNraWxsUmVmKFwibXktc2tpbGxcIiwgcmVzb2x1dGlvbnMpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9teS1za2lsbC8pO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9ub3QgZm91bmQvKTtcbiAgfSk7XG5cbiAgdGVzdChcIm1hcmtzIHVua25vd24gcmVmZXJlbmNlcyAobm90IGluIG1hcCkgd2l0aCBhIHdhcm5pbmdcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc29sdXRpb25zID0gbmV3IE1hcDxzdHJpbmcsIFNraWxsUmVzb2x1dGlvbj4oKTtcbiAgICBjb25zdCByZXN1bHQgPSBmb3JtYXRTa2lsbFJlZihcInVua25vd24tc2tpbGxcIiwgcmVzb2x1dGlvbnMpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC91bmtub3duLXNraWxsLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdCwgL25vdCBmb3VuZC8pO1xuICB9KTtcblxuICB0ZXN0KFwicmV0dXJucyBiYXJlIHJlZiBmb3IgYWJzb2x1dGUtcGF0aCByZXNvbHV0aW9uXCIsICgpID0+IHtcbiAgICBjb25zdCByZXNvbHV0aW9ucyA9IG1ha2VSZXNvbHV0aW9ucyhbXG4gICAgICBbXCIvaG9tZS91c2VyL3NraWxscy9TS0lMTC5tZFwiLCB7XG4gICAgICAgIG1ldGhvZDogXCJhYnNvbHV0ZS1wYXRoXCIsXG4gICAgICAgIHJlc29sdmVkUGF0aDogXCIvaG9tZS91c2VyL3NraWxscy9TS0lMTC5tZFwiLFxuICAgICAgfV0sXG4gICAgXSk7XG4gICAgY29uc3QgcmVzdWx0ID0gZm9ybWF0U2tpbGxSZWYoXCIvaG9tZS91c2VyL3NraWxscy9TS0lMTC5tZFwiLCByZXNvbHV0aW9ucyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCIvaG9tZS91c2VyL3NraWxscy9TS0lMTC5tZFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgYmFyZSByZWYgZm9yIGFic29sdXRlLWRpciByZXNvbHV0aW9uXCIsICgpID0+IHtcbiAgICBjb25zdCByZXNvbHV0aW9ucyA9IG1ha2VSZXNvbHV0aW9ucyhbXG4gICAgICBbXCIvaG9tZS91c2VyL3NraWxscy9teS1za2lsbFwiLCB7XG4gICAgICAgIG1ldGhvZDogXCJhYnNvbHV0ZS1kaXJcIixcbiAgICAgICAgcmVzb2x2ZWRQYXRoOiBcIi9ob21lL3VzZXIvc2tpbGxzL215LXNraWxsL1NLSUxMLm1kXCIsXG4gICAgICB9XSxcbiAgICBdKTtcbiAgICBjb25zdCByZXN1bHQgPSBmb3JtYXRTa2lsbFJlZihcIi9ob21lL3VzZXIvc2tpbGxzL215LXNraWxsXCIsIHJlc29sdXRpb25zKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBcIi9ob21lL3VzZXIvc2tpbGxzL215LXNraWxsXCIpO1xuICB9KTtcblxuICB0ZXN0KFwic2hvd3MgcmVzb2x2ZWQgcGF0aCBmb3IgdXNlci1za2lsbCByZXNvbHV0aW9uXCIsICgpID0+IHtcbiAgICBjb25zdCByZXNvbHV0aW9ucyA9IG1ha2VSZXNvbHV0aW9ucyhbXG4gICAgICBbXCJjb2RlLXJldmlld1wiLCB7XG4gICAgICAgIG1ldGhvZDogXCJ1c2VyLXNraWxsXCIsXG4gICAgICAgIHJlc29sdmVkUGF0aDogXCIvaG9tZS91c2VyLy5jbGF1ZGUvc2tpbGxzL2NvZGUtcmV2aWV3L1NLSUxMLm1kXCIsXG4gICAgICB9XSxcbiAgICBdKTtcbiAgICBjb25zdCByZXN1bHQgPSBmb3JtYXRTa2lsbFJlZihcImNvZGUtcmV2aWV3XCIsIHJlc29sdXRpb25zKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvY29kZS1yZXZpZXcvKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvXFwuY2xhdWRlXFwvc2tpbGxzXFwvY29kZS1yZXZpZXdcXC9TS0lMTFxcLm1kLyk7XG4gIH0pO1xuXG4gIHRlc3QoXCJzaG93cyByZXNvbHZlZCBwYXRoIGZvciBwcm9qZWN0LXNraWxsIHJlc29sdXRpb25cIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc29sdXRpb25zID0gbWFrZVJlc29sdXRpb25zKFtcbiAgICAgIFtcImxpbnQtZml4XCIsIHtcbiAgICAgICAgbWV0aG9kOiBcInByb2plY3Qtc2tpbGxcIixcbiAgICAgICAgcmVzb2x2ZWRQYXRoOiBcIi9yZXBvLy5nc2Qvc2tpbGxzL2xpbnQtZml4L1NLSUxMLm1kXCIsXG4gICAgICB9XSxcbiAgICBdKTtcbiAgICBjb25zdCByZXN1bHQgPSBmb3JtYXRTa2lsbFJlZihcImxpbnQtZml4XCIsIHJlc29sdXRpb25zKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvbGludC1maXgvKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvXFwuZ3NkXFwvc2tpbGxzXFwvbGludC1maXhcXC9TS0lMTFxcLm1kLyk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFNQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFFbkIsU0FBUyxzQkFBc0I7QUFHL0IsU0FBUyxnQkFBZ0IsU0FBNkU7QUFDcEcsUUFBTSxNQUFNLG9CQUFJLElBQTZCO0FBQzdDLGFBQVcsQ0FBQyxLQUFLLE9BQU8sS0FBSyxTQUFTO0FBQ3BDLFFBQUksSUFBSSxLQUFLO0FBQUEsTUFDWCxVQUFVLFFBQVEsWUFBWTtBQUFBLE1BQzlCLGNBQWMsUUFBUSxnQkFBZ0I7QUFBQSxNQUN0QyxRQUFRLFFBQVEsVUFBVTtBQUFBLElBQzVCLENBQUM7QUFBQSxFQUNIO0FBQ0EsU0FBTztBQUNUO0FBRUEsU0FBUyxrQkFBa0IsTUFBTTtBQUMvQixPQUFLLDhDQUE4QyxNQUFNO0FBQ3ZELFVBQU0sY0FBYyxnQkFBZ0I7QUFBQSxNQUNsQyxDQUFDLFlBQVksRUFBRSxRQUFRLGFBQWEsQ0FBQztBQUFBLElBQ3ZDLENBQUM7QUFDRCxVQUFNLFNBQVMsZUFBZSxZQUFZLFdBQVc7QUFDckQsV0FBTyxNQUFNLFFBQVEsVUFBVTtBQUMvQixXQUFPLE1BQU0sUUFBUSxXQUFXO0FBQUEsRUFDbEMsQ0FBQztBQUVELE9BQUssd0RBQXdELE1BQU07QUFDakUsVUFBTSxjQUFjLG9CQUFJLElBQTZCO0FBQ3JELFVBQU0sU0FBUyxlQUFlLGlCQUFpQixXQUFXO0FBQzFELFdBQU8sTUFBTSxRQUFRLGVBQWU7QUFDcEMsV0FBTyxNQUFNLFFBQVEsV0FBVztBQUFBLEVBQ2xDLENBQUM7QUFFRCxPQUFLLGlEQUFpRCxNQUFNO0FBQzFELFVBQU0sY0FBYyxnQkFBZ0I7QUFBQSxNQUNsQyxDQUFDLDhCQUE4QjtBQUFBLFFBQzdCLFFBQVE7QUFBQSxRQUNSLGNBQWM7QUFBQSxNQUNoQixDQUFDO0FBQUEsSUFDSCxDQUFDO0FBQ0QsVUFBTSxTQUFTLGVBQWUsOEJBQThCLFdBQVc7QUFDdkUsV0FBTyxNQUFNLFFBQVEsNEJBQTRCO0FBQUEsRUFDbkQsQ0FBQztBQUVELE9BQUssZ0RBQWdELE1BQU07QUFDekQsVUFBTSxjQUFjLGdCQUFnQjtBQUFBLE1BQ2xDLENBQUMsOEJBQThCO0FBQUEsUUFDN0IsUUFBUTtBQUFBLFFBQ1IsY0FBYztBQUFBLE1BQ2hCLENBQUM7QUFBQSxJQUNILENBQUM7QUFDRCxVQUFNLFNBQVMsZUFBZSw4QkFBOEIsV0FBVztBQUN2RSxXQUFPLE1BQU0sUUFBUSw0QkFBNEI7QUFBQSxFQUNuRCxDQUFDO0FBRUQsT0FBSyxpREFBaUQsTUFBTTtBQUMxRCxVQUFNLGNBQWMsZ0JBQWdCO0FBQUEsTUFDbEMsQ0FBQyxlQUFlO0FBQUEsUUFDZCxRQUFRO0FBQUEsUUFDUixjQUFjO0FBQUEsTUFDaEIsQ0FBQztBQUFBLElBQ0gsQ0FBQztBQUNELFVBQU0sU0FBUyxlQUFlLGVBQWUsV0FBVztBQUN4RCxXQUFPLE1BQU0sUUFBUSxhQUFhO0FBQ2xDLFdBQU8sTUFBTSxRQUFRLDBDQUEwQztBQUFBLEVBQ2pFLENBQUM7QUFFRCxPQUFLLG9EQUFvRCxNQUFNO0FBQzdELFVBQU0sY0FBYyxnQkFBZ0I7QUFBQSxNQUNsQyxDQUFDLFlBQVk7QUFBQSxRQUNYLFFBQVE7QUFBQSxRQUNSLGNBQWM7QUFBQSxNQUNoQixDQUFDO0FBQUEsSUFDSCxDQUFDO0FBQ0QsVUFBTSxTQUFTLGVBQWUsWUFBWSxXQUFXO0FBQ3JELFdBQU8sTUFBTSxRQUFRLFVBQVU7QUFDL0IsV0FBTyxNQUFNLFFBQVEsb0NBQW9DO0FBQUEsRUFDM0QsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
