import { test } from "node:test";
import assert from "node:assert/strict";
import { _roadmapHasParseableSlicesForTest } from "../guided-flow.js";
test("guided flow treats placeholder roadmaps with zero slices as not runnable", () => {
  assert.equal(
    _roadmapHasParseableSlicesForTest("# M001 Roadmap\n\nPlanning notes only.\n"),
    false
  );
});
test("guided flow accepts roadmaps with parseable slices", () => {
  assert.equal(
    _roadmapHasParseableSlicesForTest([
      "# M001 Roadmap",
      "",
      "## Slices",
      "- [ ] **S01: First slice** `risk:low` `depends:[]`"
    ].join("\n")),
    true
  );
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy96ZXJvLXNsaWNlLXJvYWRtYXAtZ3VpZGVkLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRC0yIFx1MjAxNCBHdWlkZWQgcm9hZG1hcCBzbGljZSBkZXRlY3Rpb24gcmVncmVzc2lvbiB0ZXN0cy5cblxuaW1wb3J0IHsgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuXG5pbXBvcnQgeyBfcm9hZG1hcEhhc1BhcnNlYWJsZVNsaWNlc0ZvclRlc3QgfSBmcm9tIFwiLi4vZ3VpZGVkLWZsb3cudHNcIjtcblxudGVzdChcImd1aWRlZCBmbG93IHRyZWF0cyBwbGFjZWhvbGRlciByb2FkbWFwcyB3aXRoIHplcm8gc2xpY2VzIGFzIG5vdCBydW5uYWJsZVwiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChcbiAgICBfcm9hZG1hcEhhc1BhcnNlYWJsZVNsaWNlc0ZvclRlc3QoXCIjIE0wMDEgUm9hZG1hcFxcblxcblBsYW5uaW5nIG5vdGVzIG9ubHkuXFxuXCIpLFxuICAgIGZhbHNlLFxuICApO1xufSk7XG5cbnRlc3QoXCJndWlkZWQgZmxvdyBhY2NlcHRzIHJvYWRtYXBzIHdpdGggcGFyc2VhYmxlIHNsaWNlc1wiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChcbiAgICBfcm9hZG1hcEhhc1BhcnNlYWJsZVNsaWNlc0ZvclRlc3QoW1xuICAgICAgXCIjIE0wMDEgUm9hZG1hcFwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgU2xpY2VzXCIsXG4gICAgICBcIi0gWyBdICoqUzAxOiBGaXJzdCBzbGljZSoqIGByaXNrOmxvd2AgYGRlcGVuZHM6W11gXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpKSxcbiAgICB0cnVlLFxuICApO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFFQSxTQUFTLFlBQVk7QUFDckIsT0FBTyxZQUFZO0FBRW5CLFNBQVMseUNBQXlDO0FBRWxELEtBQUssNEVBQTRFLE1BQU07QUFDckYsU0FBTztBQUFBLElBQ0wsa0NBQWtDLDBDQUEwQztBQUFBLElBQzVFO0FBQUEsRUFDRjtBQUNGLENBQUM7QUFFRCxLQUFLLHNEQUFzRCxNQUFNO0FBQy9ELFNBQU87QUFBQSxJQUNMLGtDQUFrQztBQUFBLE1BQ2hDO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRixFQUFFLEtBQUssSUFBSSxDQUFDO0FBQUEsSUFDWjtBQUFBLEVBQ0Y7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
