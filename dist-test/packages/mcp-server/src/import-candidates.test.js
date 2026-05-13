import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { _buildImportCandidates } from "./workflow-tools.js";
describe("_buildImportCandidates", () => {
  it("includes dist/ fallback for src/ paths", () => {
    const candidates = _buildImportCandidates("../../../src/resources/extensions/gsd/db-writer.js");
    assert.ok(
      candidates.some((c) => c.includes("/dist/resources/extensions/gsd/db-writer.js")),
      "should include dist/ swapped candidate"
    );
  });
  it("includes src/ fallback for dist/ paths", () => {
    const candidates = _buildImportCandidates("../../../dist/resources/extensions/gsd/db-writer.js");
    assert.ok(
      candidates.some((c) => c.includes("/src/resources/extensions/gsd/db-writer.js")),
      "should include src/ swapped candidate"
    );
  });
  it("includes .ts variants for .js paths", () => {
    const candidates = _buildImportCandidates("../../../src/resources/extensions/gsd/db-writer.js");
    assert.ok(
      candidates.some((c) => c.endsWith("db-writer.ts") && c.includes("/src/")),
      "should include .ts variant for original src/ path"
    );
    assert.ok(
      candidates.some((c) => c.endsWith("db-writer.ts") && c.includes("/dist/")),
      "should include .ts variant for swapped dist/ path"
    );
  });
  it("returns source TypeScript before stale JavaScript fallbacks", () => {
    const input = "../../../src/resources/extensions/gsd/db-writer.js";
    const candidates = _buildImportCandidates(input);
    assert.deepEqual(candidates, [
      "../../../src/resources/extensions/gsd/db-writer.ts",
      "../../../src/resources/extensions/gsd/db-writer.js",
      "../../../dist/resources/extensions/gsd/db-writer.ts",
      "../../../dist/resources/extensions/gsd/db-writer.js"
    ]);
  });
  it("handles paths without src/ or dist/ gracefully", () => {
    const candidates = _buildImportCandidates("./local-module.js");
    assert.equal(candidates.length, 2, "should have original + .ts variant only");
    assert.equal(candidates[0], "./local-module.ts");
    assert.equal(candidates[1], "./local-module.js");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvbWNwLXNlcnZlci9zcmMvaW1wb3J0LWNhbmRpZGF0ZXMudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NELTIgXHUyMDE0IFJlZ3Jlc3Npb24gdGVzdHMgZm9yIGltcG9ydExvY2FsTW9kdWxlIGNhbmRpZGF0ZSByZXNvbHV0aW9uICgjMzk1NClcbmltcG9ydCB7IGRlc2NyaWJlLCBpdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuXG5pbXBvcnQgeyBfYnVpbGRJbXBvcnRDYW5kaWRhdGVzIH0gZnJvbSBcIi4vd29ya2Zsb3ctdG9vbHMuanNcIjtcblxuZGVzY3JpYmUoXCJfYnVpbGRJbXBvcnRDYW5kaWRhdGVzXCIsICgpID0+IHtcbiAgaXQoXCJpbmNsdWRlcyBkaXN0LyBmYWxsYmFjayBmb3Igc3JjLyBwYXRoc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IF9idWlsZEltcG9ydENhbmRpZGF0ZXMoXCIuLi8uLi8uLi9zcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2RiLXdyaXRlci5qc1wiKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBjYW5kaWRhdGVzLnNvbWUoKGMpID0+IGMuaW5jbHVkZXMoXCIvZGlzdC9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvZGItd3JpdGVyLmpzXCIpKSxcbiAgICAgIFwic2hvdWxkIGluY2x1ZGUgZGlzdC8gc3dhcHBlZCBjYW5kaWRhdGVcIixcbiAgICApO1xuICB9KTtcblxuICBpdChcImluY2x1ZGVzIHNyYy8gZmFsbGJhY2sgZm9yIGRpc3QvIHBhdGhzXCIsICgpID0+IHtcbiAgICBjb25zdCBjYW5kaWRhdGVzID0gX2J1aWxkSW1wb3J0Q2FuZGlkYXRlcyhcIi4uLy4uLy4uL2Rpc3QvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2RiLXdyaXRlci5qc1wiKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBjYW5kaWRhdGVzLnNvbWUoKGMpID0+IGMuaW5jbHVkZXMoXCIvc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9kYi13cml0ZXIuanNcIikpLFxuICAgICAgXCJzaG91bGQgaW5jbHVkZSBzcmMvIHN3YXBwZWQgY2FuZGlkYXRlXCIsXG4gICAgKTtcbiAgfSk7XG5cbiAgaXQoXCJpbmNsdWRlcyAudHMgdmFyaWFudHMgZm9yIC5qcyBwYXRoc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IF9idWlsZEltcG9ydENhbmRpZGF0ZXMoXCIuLi8uLi8uLi9zcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2RiLXdyaXRlci5qc1wiKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBjYW5kaWRhdGVzLnNvbWUoKGMpID0+IGMuZW5kc1dpdGgoXCJkYi13cml0ZXIudHNcIikgJiYgYy5pbmNsdWRlcyhcIi9zcmMvXCIpKSxcbiAgICAgIFwic2hvdWxkIGluY2x1ZGUgLnRzIHZhcmlhbnQgZm9yIG9yaWdpbmFsIHNyYy8gcGF0aFwiLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgY2FuZGlkYXRlcy5zb21lKChjKSA9PiBjLmVuZHNXaXRoKFwiZGItd3JpdGVyLnRzXCIpICYmIGMuaW5jbHVkZXMoXCIvZGlzdC9cIikpLFxuICAgICAgXCJzaG91bGQgaW5jbHVkZSAudHMgdmFyaWFudCBmb3Igc3dhcHBlZCBkaXN0LyBwYXRoXCIsXG4gICAgKTtcbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIHNvdXJjZSBUeXBlU2NyaXB0IGJlZm9yZSBzdGFsZSBKYXZhU2NyaXB0IGZhbGxiYWNrc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgaW5wdXQgPSBcIi4uLy4uLy4uL3NyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvZGItd3JpdGVyLmpzXCI7XG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IF9idWlsZEltcG9ydENhbmRpZGF0ZXMoaW5wdXQpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoY2FuZGlkYXRlcywgW1xuICAgICAgXCIuLi8uLi8uLi9zcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2RiLXdyaXRlci50c1wiLFxuICAgICAgXCIuLi8uLi8uLi9zcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2RiLXdyaXRlci5qc1wiLFxuICAgICAgXCIuLi8uLi8uLi9kaXN0L3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9kYi13cml0ZXIudHNcIixcbiAgICAgIFwiLi4vLi4vLi4vZGlzdC9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvZGItd3JpdGVyLmpzXCIsXG4gICAgXSk7XG4gIH0pO1xuXG4gIGl0KFwiaGFuZGxlcyBwYXRocyB3aXRob3V0IHNyYy8gb3IgZGlzdC8gZ3JhY2VmdWxseVwiLCAoKSA9PiB7XG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IF9idWlsZEltcG9ydENhbmRpZGF0ZXMoXCIuL2xvY2FsLW1vZHVsZS5qc1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoY2FuZGlkYXRlcy5sZW5ndGgsIDIsIFwic2hvdWxkIGhhdmUgb3JpZ2luYWwgKyAudHMgdmFyaWFudCBvbmx5XCIpO1xuICAgIGFzc2VydC5lcXVhbChjYW5kaWRhdGVzWzBdLCBcIi4vbG9jYWwtbW9kdWxlLnRzXCIpO1xuICAgIGFzc2VydC5lcXVhbChjYW5kaWRhdGVzWzFdLCBcIi4vbG9jYWwtbW9kdWxlLmpzXCIpO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQ0EsU0FBUyxVQUFVLFVBQVU7QUFDN0IsT0FBTyxZQUFZO0FBRW5CLFNBQVMsOEJBQThCO0FBRXZDLFNBQVMsMEJBQTBCLE1BQU07QUFDdkMsS0FBRywwQ0FBMEMsTUFBTTtBQUNqRCxVQUFNLGFBQWEsdUJBQXVCLG9EQUFvRDtBQUM5RixXQUFPO0FBQUEsTUFDTCxXQUFXLEtBQUssQ0FBQyxNQUFNLEVBQUUsU0FBUyw2Q0FBNkMsQ0FBQztBQUFBLE1BQ2hGO0FBQUEsSUFDRjtBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsMENBQTBDLE1BQU07QUFDakQsVUFBTSxhQUFhLHVCQUF1QixxREFBcUQ7QUFDL0YsV0FBTztBQUFBLE1BQ0wsV0FBVyxLQUFLLENBQUMsTUFBTSxFQUFFLFNBQVMsNENBQTRDLENBQUM7QUFBQSxNQUMvRTtBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFFRCxLQUFHLHVDQUF1QyxNQUFNO0FBQzlDLFVBQU0sYUFBYSx1QkFBdUIsb0RBQW9EO0FBQzlGLFdBQU87QUFBQSxNQUNMLFdBQVcsS0FBSyxDQUFDLE1BQU0sRUFBRSxTQUFTLGNBQWMsS0FBSyxFQUFFLFNBQVMsT0FBTyxDQUFDO0FBQUEsTUFDeEU7QUFBQSxJQUNGO0FBQ0EsV0FBTztBQUFBLE1BQ0wsV0FBVyxLQUFLLENBQUMsTUFBTSxFQUFFLFNBQVMsY0FBYyxLQUFLLEVBQUUsU0FBUyxRQUFRLENBQUM7QUFBQSxNQUN6RTtBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFFRCxLQUFHLCtEQUErRCxNQUFNO0FBQ3RFLFVBQU0sUUFBUTtBQUNkLFVBQU0sYUFBYSx1QkFBdUIsS0FBSztBQUMvQyxXQUFPLFVBQVUsWUFBWTtBQUFBLE1BQzNCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRixDQUFDO0FBQUEsRUFDSCxDQUFDO0FBRUQsS0FBRyxrREFBa0QsTUFBTTtBQUN6RCxVQUFNLGFBQWEsdUJBQXVCLG1CQUFtQjtBQUM3RCxXQUFPLE1BQU0sV0FBVyxRQUFRLEdBQUcseUNBQXlDO0FBQzVFLFdBQU8sTUFBTSxXQUFXLENBQUMsR0FBRyxtQkFBbUI7QUFDL0MsV0FBTyxNQUFNLFdBQVcsQ0FBQyxHQUFHLG1CQUFtQjtBQUFBLEVBQ2pELENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
