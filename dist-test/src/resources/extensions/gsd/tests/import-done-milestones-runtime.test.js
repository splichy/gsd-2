import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openDatabase,
  closeDatabase,
  getAllMilestones
} from "../gsd-db.js";
import { migrateHierarchyToDb } from "../md-importer.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
function createFixtureBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-import-done-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}
function writeFile(base, relativePath, content) {
  const full = join(base, ".gsd", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}
function cleanup(base) {
  rmSync(base, { recursive: true, force: true });
}
const ROADMAP_ALL_DONE = `# M001: Finished Milestone

**Vision:** Done work.

## Slices

- [x] **S01: First Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.

- [x] **S02: Second Slice** \`risk:medium\` \`depends:[S01]\`
  > After this: Also done.
`;
const ROADMAP_PARTIAL = `# M002: In-Progress Milestone

**Vision:** Mid-flight.

## Slices

- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.

- [ ] **S02: Pending Slice** \`risk:medium\` \`depends:[S01]\`
  > After this: TBD.
`;
const ROADMAP_EMPTY = `# M003: Empty Milestone

**Vision:** No slices yet.

## Slices

`;
describe("migrateHierarchyToDb: all-done milestones import as complete (#4902)", () => {
  test("milestone with all [x] slices and no SUMMARY imports as complete", () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_ALL_DONE);
      openDatabase(":memory:");
      migrateHierarchyToDb(base);
      const milestones = getAllMilestones();
      const m001 = milestones.find((m) => m.id === "M001");
      assert.ok(m001, "M001 should be imported");
      assert.equal(
        m001.status,
        "complete",
        "milestone with all-done slices must import as complete"
      );
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("milestone with one pending slice imports as active (negative case)", () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M002/M002-ROADMAP.md", ROADMAP_PARTIAL);
      openDatabase(":memory:");
      migrateHierarchyToDb(base);
      const milestones = getAllMilestones();
      const m002 = milestones.find((m) => m.id === "M002");
      assert.ok(m002, "M002 should be imported");
      assert.equal(
        m002.status,
        "active",
        "milestone with at least one pending slice must NOT be marked complete"
      );
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("milestone with empty slice list does not import as complete", () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M003/M003-ROADMAP.md", ROADMAP_EMPTY);
      openDatabase(":memory:");
      migrateHierarchyToDb(base);
      const milestones = getAllMilestones();
      const m003 = milestones.find((m) => m.id === "M003");
      assert.ok(m003, "M003 should be imported");
      assert.notEqual(
        m003.status,
        "complete",
        "empty roadmap (no slices) must not import as complete"
      );
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9pbXBvcnQtZG9uZS1taWxlc3RvbmVzLXJ1bnRpbWUudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBSdW50aW1lIHJlZ3Jlc3Npb24gXHUyMDE0IG1pbGVzdG9uZXMgd2l0aCBhbGwtZG9uZSByb2FkbWFwIHNsaWNlcyBpbXBvcnQgYXNcbiAqIGBjb21wbGV0ZWAgKCMzNjk5IC8gIzMzOTAgLyAjMzM3OSksIGZvbGxvdy11cCAjNDkwMi5cbiAqXG4gKiBUaGUgZGVsZXRlZCBgaW1wb3J0LWRvbmUtbWlsZXN0b25lcy50ZXN0LnRzYCB3YXMgYSBzb3VyY2UtZ3JlcCBjaGVja1xuICogZm9yIHRoZSBsaXRlcmFsIGByb2FkbWFwLnNsaWNlcy5ldmVyeShzID0+IHMuZG9uZSlgLiBUaGlzIHJld3JpdGVcbiAqIGV4ZXJjaXNlcyBgbWlncmF0ZUhpZXJhcmNoeVRvRGIoKWAgYWdhaW5zdCBhIGZpeHR1cmUgcm9hZG1hcCB3aG9zZVxuICogc2xpY2VzIGFyZSBhbGwgYFt4XWAgYW5kIGFzc2VydHMgdGhlIG1pbGVzdG9uZSByb3cncyBgc3RhdHVzYCBpc1xuICogYGNvbXBsZXRlYCBcdTIwMTQgdGhlIGFjdHVhbCBiZWhhdmlvdXIgdGhlIGV2ZXJ5KCkgY2hlY2sgZXhpc3RzIHRvXG4gKiBwcm9kdWNlLlxuICovXG5cbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tICdub2RlOm9zJztcblxuaW1wb3J0IHtcbiAgb3BlbkRhdGFiYXNlLFxuICBjbG9zZURhdGFiYXNlLFxuICBnZXRBbGxNaWxlc3RvbmVzLFxufSBmcm9tICcuLi9nc2QtZGIudHMnO1xuaW1wb3J0IHsgbWlncmF0ZUhpZXJhcmNoeVRvRGIgfSBmcm9tICcuLi9tZC1pbXBvcnRlci50cyc7XG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5cbmZ1bmN0aW9uIGNyZWF0ZUZpeHR1cmVCYXNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLWltcG9ydC1kb25lLScpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIHdyaXRlRmlsZShiYXNlOiBzdHJpbmcsIHJlbGF0aXZlUGF0aDogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZnVsbCA9IGpvaW4oYmFzZSwgJy5nc2QnLCByZWxhdGl2ZVBhdGgpO1xuICBta2RpclN5bmMoam9pbihmdWxsLCAnLi4nKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoZnVsbCwgY29udGVudCk7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59XG5cbmNvbnN0IFJPQURNQVBfQUxMX0RPTkUgPSBgIyBNMDAxOiBGaW5pc2hlZCBNaWxlc3RvbmVcblxuKipWaXNpb246KiogRG9uZSB3b3JrLlxuXG4jIyBTbGljZXNcblxuLSBbeF0gKipTMDE6IEZpcnN0IFNsaWNlKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IERvbmUuXG5cbi0gW3hdICoqUzAyOiBTZWNvbmQgU2xpY2UqKiBcXGByaXNrOm1lZGl1bVxcYCBcXGBkZXBlbmRzOltTMDFdXFxgXG4gID4gQWZ0ZXIgdGhpczogQWxzbyBkb25lLlxuYDtcblxuY29uc3QgUk9BRE1BUF9QQVJUSUFMID0gYCMgTTAwMjogSW4tUHJvZ3Jlc3MgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIE1pZC1mbGlnaHQuXG5cbiMjIFNsaWNlc1xuXG4tIFt4XSAqKlMwMTogRG9uZSBTbGljZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbiAgPiBBZnRlciB0aGlzOiBEb25lLlxuXG4tIFsgXSAqKlMwMjogUGVuZGluZyBTbGljZSoqIFxcYHJpc2s6bWVkaXVtXFxgIFxcYGRlcGVuZHM6W1MwMV1cXGBcbiAgPiBBZnRlciB0aGlzOiBUQkQuXG5gO1xuXG5jb25zdCBST0FETUFQX0VNUFRZID0gYCMgTTAwMzogRW1wdHkgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIE5vIHNsaWNlcyB5ZXQuXG5cbiMjIFNsaWNlc1xuXG5gO1xuXG5kZXNjcmliZSgnbWlncmF0ZUhpZXJhcmNoeVRvRGI6IGFsbC1kb25lIG1pbGVzdG9uZXMgaW1wb3J0IGFzIGNvbXBsZXRlICgjNDkwMiknLCAoKSA9PiB7XG4gIHRlc3QoJ21pbGVzdG9uZSB3aXRoIGFsbCBbeF0gc2xpY2VzIGFuZCBubyBTVU1NQVJZIGltcG9ydHMgYXMgY29tcGxldGUnLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtUk9BRE1BUC5tZCcsIFJPQURNQVBfQUxMX0RPTkUpO1xuICAgICAgLy8gTm8gU1VNTUFSWS5tZCBcdTIwMTQgdGhlIGFsbC1kb25lIHJvYWRtYXAgY2hlY2sgaXMgdGhlIGF1dGhvcml0YXRpdmUgc2lnbmFsLlxuXG4gICAgICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG4gICAgICBtaWdyYXRlSGllcmFyY2h5VG9EYihiYXNlKTtcblxuICAgICAgY29uc3QgbWlsZXN0b25lcyA9IGdldEFsbE1pbGVzdG9uZXMoKTtcbiAgICAgIGNvbnN0IG0wMDEgPSBtaWxlc3RvbmVzLmZpbmQoKG0pID0+IG0uaWQgPT09ICdNMDAxJyk7XG4gICAgICBhc3NlcnQub2sobTAwMSwgJ00wMDEgc2hvdWxkIGJlIGltcG9ydGVkJyk7XG4gICAgICBhc3NlcnQuZXF1YWwoXG4gICAgICAgIG0wMDEhLnN0YXR1cyxcbiAgICAgICAgJ2NvbXBsZXRlJyxcbiAgICAgICAgJ21pbGVzdG9uZSB3aXRoIGFsbC1kb25lIHNsaWNlcyBtdXN0IGltcG9ydCBhcyBjb21wbGV0ZScsXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdCgnbWlsZXN0b25lIHdpdGggb25lIHBlbmRpbmcgc2xpY2UgaW1wb3J0cyBhcyBhY3RpdmUgKG5lZ2F0aXZlIGNhc2UpJywgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMi9NMDAyLVJPQURNQVAubWQnLCBST0FETUFQX1BBUlRJQUwpO1xuXG4gICAgICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG4gICAgICBtaWdyYXRlSGllcmFyY2h5VG9EYihiYXNlKTtcblxuICAgICAgY29uc3QgbWlsZXN0b25lcyA9IGdldEFsbE1pbGVzdG9uZXMoKTtcbiAgICAgIGNvbnN0IG0wMDIgPSBtaWxlc3RvbmVzLmZpbmQoKG0pID0+IG0uaWQgPT09ICdNMDAyJyk7XG4gICAgICBhc3NlcnQub2sobTAwMiwgJ00wMDIgc2hvdWxkIGJlIGltcG9ydGVkJyk7XG4gICAgICBhc3NlcnQuZXF1YWwoXG4gICAgICAgIG0wMDIhLnN0YXR1cyxcbiAgICAgICAgJ2FjdGl2ZScsXG4gICAgICAgICdtaWxlc3RvbmUgd2l0aCBhdCBsZWFzdCBvbmUgcGVuZGluZyBzbGljZSBtdXN0IE5PVCBiZSBtYXJrZWQgY29tcGxldGUnLFxuICAgICAgKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoJ21pbGVzdG9uZSB3aXRoIGVtcHR5IHNsaWNlIGxpc3QgZG9lcyBub3QgaW1wb3J0IGFzIGNvbXBsZXRlJywgKCkgPT4ge1xuICAgIC8vIEd1YXJkcyB0aGUgYHJvYWRtYXAuc2xpY2VzLmxlbmd0aCA+IDBgIHByZWNvbmRpdGlvbjogYW4gZW1wdHkgcm9hZG1hcFxuICAgIC8vIG11c3Qgbm90IGJlIG1pc3JlYWQgYXMgXCJldmVyeXRoaW5nIGlzIGRvbmVcIiAodmFjdW91cyB0cnV0aCBidWcpLlxuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMy9NMDAzLVJPQURNQVAubWQnLCBST0FETUFQX0VNUFRZKTtcblxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgbWlncmF0ZUhpZXJhcmNoeVRvRGIoYmFzZSk7XG5cbiAgICAgIGNvbnN0IG1pbGVzdG9uZXMgPSBnZXRBbGxNaWxlc3RvbmVzKCk7XG4gICAgICBjb25zdCBtMDAzID0gbWlsZXN0b25lcy5maW5kKChtKSA9PiBtLmlkID09PSAnTTAwMycpO1xuICAgICAgYXNzZXJ0Lm9rKG0wMDMsICdNMDAzIHNob3VsZCBiZSBpbXBvcnRlZCcpO1xuICAgICAgYXNzZXJ0Lm5vdEVxdWFsKFxuICAgICAgICBtMDAzIS5zdGF0dXMsXG4gICAgICAgICdjb21wbGV0ZScsXG4gICAgICAgICdlbXB0eSByb2FkbWFwIChubyBzbGljZXMpIG11c3Qgbm90IGltcG9ydCBhcyBjb21wbGV0ZScsXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVlBLFNBQVMsYUFBYSxXQUFXLFFBQVEscUJBQXFCO0FBQzlELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyw0QkFBNEI7QUFDckMsU0FBUyxVQUFVLFlBQVk7QUFDL0IsT0FBTyxZQUFZO0FBRW5CLFNBQVMsb0JBQTRCO0FBQ25DLFFBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLGtCQUFrQixDQUFDO0FBQzNELFlBQVUsS0FBSyxNQUFNLFFBQVEsWUFBWSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDL0QsU0FBTztBQUNUO0FBRUEsU0FBUyxVQUFVLE1BQWMsY0FBc0IsU0FBdUI7QUFDNUUsUUFBTSxPQUFPLEtBQUssTUFBTSxRQUFRLFlBQVk7QUFDNUMsWUFBVSxLQUFLLE1BQU0sSUFBSSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDL0MsZ0JBQWMsTUFBTSxPQUFPO0FBQzdCO0FBRUEsU0FBUyxRQUFRLE1BQW9CO0FBQ25DLFNBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUMvQztBQUVBLE1BQU0sbUJBQW1CO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQWF6QixNQUFNLGtCQUFrQjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFheEIsTUFBTSxnQkFBZ0I7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFRdEIsU0FBUyx3RUFBd0UsTUFBTTtBQUNyRixPQUFLLG9FQUFvRSxNQUFNO0FBQzdFLFVBQU0sT0FBTyxrQkFBa0I7QUFDL0IsUUFBSTtBQUNGLGdCQUFVLE1BQU0sbUNBQW1DLGdCQUFnQjtBQUduRSxtQkFBYSxVQUFVO0FBQ3ZCLDJCQUFxQixJQUFJO0FBRXpCLFlBQU0sYUFBYSxpQkFBaUI7QUFDcEMsWUFBTSxPQUFPLFdBQVcsS0FBSyxDQUFDLE1BQU0sRUFBRSxPQUFPLE1BQU07QUFDbkQsYUFBTyxHQUFHLE1BQU0seUJBQXlCO0FBQ3pDLGFBQU87QUFBQSxRQUNMLEtBQU07QUFBQSxRQUNOO0FBQUEsUUFDQTtBQUFBLE1BQ0Y7QUFBQSxJQUNGLFVBQUU7QUFDQSxvQkFBYztBQUNkLGNBQVEsSUFBSTtBQUFBLElBQ2Q7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLHNFQUFzRSxNQUFNO0FBQy9FLFVBQU0sT0FBTyxrQkFBa0I7QUFDL0IsUUFBSTtBQUNGLGdCQUFVLE1BQU0sbUNBQW1DLGVBQWU7QUFFbEUsbUJBQWEsVUFBVTtBQUN2QiwyQkFBcUIsSUFBSTtBQUV6QixZQUFNLGFBQWEsaUJBQWlCO0FBQ3BDLFlBQU0sT0FBTyxXQUFXLEtBQUssQ0FBQyxNQUFNLEVBQUUsT0FBTyxNQUFNO0FBQ25ELGFBQU8sR0FBRyxNQUFNLHlCQUF5QjtBQUN6QyxhQUFPO0FBQUEsUUFDTCxLQUFNO0FBQUEsUUFDTjtBQUFBLFFBQ0E7QUFBQSxNQUNGO0FBQUEsSUFDRixVQUFFO0FBQ0Esb0JBQWM7QUFDZCxjQUFRLElBQUk7QUFBQSxJQUNkO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSywrREFBK0QsTUFBTTtBQUd4RSxVQUFNLE9BQU8sa0JBQWtCO0FBQy9CLFFBQUk7QUFDRixnQkFBVSxNQUFNLG1DQUFtQyxhQUFhO0FBRWhFLG1CQUFhLFVBQVU7QUFDdkIsMkJBQXFCLElBQUk7QUFFekIsWUFBTSxhQUFhLGlCQUFpQjtBQUNwQyxZQUFNLE9BQU8sV0FBVyxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sTUFBTTtBQUNuRCxhQUFPLEdBQUcsTUFBTSx5QkFBeUI7QUFDekMsYUFBTztBQUFBLFFBQ0wsS0FBTTtBQUFBLFFBQ047QUFBQSxRQUNBO0FBQUEsTUFDRjtBQUFBLElBQ0YsVUFBRTtBQUNBLG9CQUFjO0FBQ2QsY0FBUSxJQUFJO0FBQUEsSUFDZDtBQUFBLEVBQ0YsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
