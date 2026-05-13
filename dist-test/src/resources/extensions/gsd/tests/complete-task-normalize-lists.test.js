import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { normalizeListParam } from "../tools/complete-task.js";
import { parseRoadmapSlices } from "../roadmap-slices.js";
describe("complete-task normalizeListParam (#3692)", () => {
  test("normalizes newline-delimited key file strings", () => {
    assert.deepEqual(
      normalizeListParam("- src/app.ts\n* tests/app.test.ts\n  docs/notes.md"),
      ["src/app.ts", "tests/app.test.ts", "docs/notes.md"]
    );
  });
  test("normalizes arrays and empty values", () => {
    assert.deepEqual(normalizeListParam(["api", 42]), ["api", "42"]);
    assert.deepEqual(normalizeListParam("   "), []);
    assert.deepEqual(normalizeListParam(void 0), []);
  });
});
describe("roadmap-slices depColumnIndex detection (#3692)", () => {
  test("parses dependencies from the dependency table column only", () => {
    const slices = parseRoadmapSlices([
      "## Slices",
      "| ID | Title | Risk | Depends | Status |",
      "| -- | ----- | ---- | ------- | ------ |",
      "| S01 | Foundation | low | none | Done |",
      "| S02 | Title mentions S01 but no dependency | medium | none | Pending |",
      "| S03 | Integration | high | S01, S02 | Pending |"
    ].join("\n"));
    assert.deepEqual(
      slices.map((slice) => ({ id: slice.id, depends: slice.depends })),
      [
        { id: "S01", depends: [] },
        { id: "S02", depends: [] },
        { id: "S03", depends: ["S01", "S02"] }
      ]
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb21wbGV0ZS10YXNrLW5vcm1hbGl6ZS1saXN0cy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlZ3Jlc3Npb24gdGVzdCBmb3IgIzM2OTIgXHUyMDE0IG5vcm1hbGl6ZUxpc3RQYXJhbSBpbiBjb21wbGV0ZS10YXNrXG4gKlxuICogQWdlbnRzIHNvbWV0aW1lcyBwYXNzIGtleUZpbGVzL2tleURlY2lzaW9ucyBhcyBjb21tYS1zZXBhcmF0ZWQgc3RyaW5nc1xuICogaW5zdGVhZCBvZiBhcnJheXMuICBub3JtYWxpemVMaXN0UGFyYW0gY29lcmNlcyBib3RoIGZvcm1zIHRvIHN0cmluZ1tdLlxuICpcbiAqIEFsc28gdmVyaWZpZXMgcm9hZG1hcC1zbGljZXMudHMgZGV0ZWN0cyBkZXBlbmRlbmN5IGNvbHVtbiBmcm9tIGhlYWRlci5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBub3JtYWxpemVMaXN0UGFyYW0gfSBmcm9tIFwiLi4vdG9vbHMvY29tcGxldGUtdGFzay50c1wiO1xuaW1wb3J0IHsgcGFyc2VSb2FkbWFwU2xpY2VzIH0gZnJvbSBcIi4uL3JvYWRtYXAtc2xpY2VzLnRzXCI7XG5cbmRlc2NyaWJlKCdjb21wbGV0ZS10YXNrIG5vcm1hbGl6ZUxpc3RQYXJhbSAoIzM2OTIpJywgKCkgPT4ge1xuICB0ZXN0KCdub3JtYWxpemVzIG5ld2xpbmUtZGVsaW1pdGVkIGtleSBmaWxlIHN0cmluZ3MnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICAgIG5vcm1hbGl6ZUxpc3RQYXJhbShcIi0gc3JjL2FwcC50c1xcbiogdGVzdHMvYXBwLnRlc3QudHNcXG4gIGRvY3Mvbm90ZXMubWRcIiksXG4gICAgICBbXCJzcmMvYXBwLnRzXCIsIFwidGVzdHMvYXBwLnRlc3QudHNcIiwgXCJkb2NzL25vdGVzLm1kXCJdLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoJ25vcm1hbGl6ZXMgYXJyYXlzIGFuZCBlbXB0eSB2YWx1ZXMnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChub3JtYWxpemVMaXN0UGFyYW0oW1wiYXBpXCIsIDQyXSksIFtcImFwaVwiLCBcIjQyXCJdKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKG5vcm1hbGl6ZUxpc3RQYXJhbShcIiAgIFwiKSwgW10pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwobm9ybWFsaXplTGlzdFBhcmFtKHVuZGVmaW5lZCksIFtdKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoJ3JvYWRtYXAtc2xpY2VzIGRlcENvbHVtbkluZGV4IGRldGVjdGlvbiAoIzM2OTIpJywgKCkgPT4ge1xuICB0ZXN0KCdwYXJzZXMgZGVwZW5kZW5jaWVzIGZyb20gdGhlIGRlcGVuZGVuY3kgdGFibGUgY29sdW1uIG9ubHknLCAoKSA9PiB7XG4gICAgY29uc3Qgc2xpY2VzID0gcGFyc2VSb2FkbWFwU2xpY2VzKFtcbiAgICAgIFwiIyMgU2xpY2VzXCIsXG4gICAgICBcInwgSUQgfCBUaXRsZSB8IFJpc2sgfCBEZXBlbmRzIHwgU3RhdHVzIHxcIixcbiAgICAgIFwifCAtLSB8IC0tLS0tIHwgLS0tLSB8IC0tLS0tLS0gfCAtLS0tLS0gfFwiLFxuICAgICAgXCJ8IFMwMSB8IEZvdW5kYXRpb24gfCBsb3cgfCBub25lIHwgRG9uZSB8XCIsXG4gICAgICBcInwgUzAyIHwgVGl0bGUgbWVudGlvbnMgUzAxIGJ1dCBubyBkZXBlbmRlbmN5IHwgbWVkaXVtIHwgbm9uZSB8IFBlbmRpbmcgfFwiLFxuICAgICAgXCJ8IFMwMyB8IEludGVncmF0aW9uIHwgaGlnaCB8IFMwMSwgUzAyIHwgUGVuZGluZyB8XCIsXG4gICAgXS5qb2luKFwiXFxuXCIpKTtcblxuICAgIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgICBzbGljZXMubWFwKChzbGljZSkgPT4gKHsgaWQ6IHNsaWNlLmlkLCBkZXBlbmRzOiBzbGljZS5kZXBlbmRzIH0pKSxcbiAgICAgIFtcbiAgICAgICAgeyBpZDogXCJTMDFcIiwgZGVwZW5kczogW10gfSxcbiAgICAgICAgeyBpZDogXCJTMDJcIiwgZGVwZW5kczogW10gfSxcbiAgICAgICAgeyBpZDogXCJTMDNcIiwgZGVwZW5kczogW1wiUzAxXCIsIFwiUzAyXCJdIH0sXG4gICAgICBdLFxuICAgICk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFTQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFDbkIsU0FBUywwQkFBMEI7QUFDbkMsU0FBUywwQkFBMEI7QUFFbkMsU0FBUyw0Q0FBNEMsTUFBTTtBQUN6RCxPQUFLLGlEQUFpRCxNQUFNO0FBQzFELFdBQU87QUFBQSxNQUNMLG1CQUFtQixvREFBb0Q7QUFBQSxNQUN2RSxDQUFDLGNBQWMscUJBQXFCLGVBQWU7QUFBQSxJQUNyRDtBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssc0NBQXNDLE1BQU07QUFDL0MsV0FBTyxVQUFVLG1CQUFtQixDQUFDLE9BQU8sRUFBRSxDQUFDLEdBQUcsQ0FBQyxPQUFPLElBQUksQ0FBQztBQUMvRCxXQUFPLFVBQVUsbUJBQW1CLEtBQUssR0FBRyxDQUFDLENBQUM7QUFDOUMsV0FBTyxVQUFVLG1CQUFtQixNQUFTLEdBQUcsQ0FBQyxDQUFDO0FBQUEsRUFDcEQsQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLG1EQUFtRCxNQUFNO0FBQ2hFLE9BQUssNkRBQTZELE1BQU07QUFDdEUsVUFBTSxTQUFTLG1CQUFtQjtBQUFBLE1BQ2hDO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGLEVBQUUsS0FBSyxJQUFJLENBQUM7QUFFWixXQUFPO0FBQUEsTUFDTCxPQUFPLElBQUksQ0FBQyxXQUFXLEVBQUUsSUFBSSxNQUFNLElBQUksU0FBUyxNQUFNLFFBQVEsRUFBRTtBQUFBLE1BQ2hFO0FBQUEsUUFDRSxFQUFFLElBQUksT0FBTyxTQUFTLENBQUMsRUFBRTtBQUFBLFFBQ3pCLEVBQUUsSUFBSSxPQUFPLFNBQVMsQ0FBQyxFQUFFO0FBQUEsUUFDekIsRUFBRSxJQUFJLE9BQU8sU0FBUyxDQUFDLE9BQU8sS0FBSyxFQUFFO0FBQUEsTUFDdkM7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
