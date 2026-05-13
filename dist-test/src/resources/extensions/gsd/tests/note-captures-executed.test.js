import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAllCaptures } from "../captures.js";
import { executeTriageResolutions } from "../triage-resolution.js";
describe("note captures executed in triage resolution (#3578)", () => {
  test("resolved note captures are stamped executed", () => {
    const base = mkdtempSync(join(tmpdir(), "gsd-note-capture-"));
    try {
      mkdirSync(join(base, ".gsd"), { recursive: true });
      writeFileSync(join(base, ".gsd", "CAPTURES.md"), [
        "# Captures",
        "",
        "### cap-note",
        "**Text:** Remember this",
        "**Captured:** 2026-01-01T00:00:00.000Z",
        "**Status:** resolved",
        "**Classification:** note",
        "**Resolution:** informational only",
        "**Resolved:** 2026-01-01T00:01:00.000Z",
        ""
      ].join("\n"));
      const result = executeTriageResolutions(base, "M001", "S01");
      const [capture] = loadAllCaptures(base);
      assert.equal(result.injected, 0);
      assert.equal(result.replanned, 0);
      assert.ok(result.actions.some((action) => action.includes("Note acknowledged: cap-note")));
      assert.equal(capture?.executed, true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9ub3RlLWNhcHR1cmVzLWV4ZWN1dGVkLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUmVncmVzc2lvbiB0ZXN0IGZvciAjMzU3OCBcdTIwMTQgbm90ZSBjYXB0dXJlcyBtYXJrZWQgYXMgZXhlY3V0ZWRcbiAqXG4gKiBOb3RlLWNsYXNzaWZpZWQgY2FwdHVyZXMgd2VyZSBzdHVjayBpbiBcInJlc29sdmVkIGJ1dCBub3QgZXhlY3V0ZWRcIiBsaW1ib1xuICogYmVjYXVzZSBleGVjdXRlVHJpYWdlUmVzb2x1dGlvbnMgb25seSBoYW5kbGVkIGluamVjdC9yZXBsYW4vZGVmZXIuIFRoZSBmaXhcbiAqIGFkZHMgYSBmaWx0ZXIgZm9yIGNsYXNzaWZpY2F0aW9uID09PSBcIm5vdGVcIiBhbmQgY2FsbHMgbWFya0NhcHR1cmVFeGVjdXRlZFxuICogZm9yIGVhY2ggbWF0Y2hpbmcgY2FwdHVyZS5cbiAqXG4gKiBCZWhhdmlvciB0ZXN0IFx1MjAxNCByZXNvbHZlZCBub3RlIGNhcHR1cmVzIHNob3VsZCBiZSBtYXJrZWQgZXhlY3V0ZWQgd2l0aG91dFxuICogZGlzcGF0Y2hpbmcgaW5qZWN0L3JlcGxhbiB3b3JrLlxuICovXG5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0IH0gZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcbmltcG9ydCB7IG1rZGlyU3luYywgbWtkdGVtcFN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tICdub2RlOm9zJztcbmltcG9ydCB7IGxvYWRBbGxDYXB0dXJlcyB9IGZyb20gJy4uL2NhcHR1cmVzLnRzJztcbmltcG9ydCB7IGV4ZWN1dGVUcmlhZ2VSZXNvbHV0aW9ucyB9IGZyb20gJy4uL3RyaWFnZS1yZXNvbHV0aW9uLnRzJztcblxuZGVzY3JpYmUoJ25vdGUgY2FwdHVyZXMgZXhlY3V0ZWQgaW4gdHJpYWdlIHJlc29sdXRpb24gKCMzNTc4KScsICgpID0+IHtcbiAgdGVzdCgncmVzb2x2ZWQgbm90ZSBjYXB0dXJlcyBhcmUgc3RhbXBlZCBleGVjdXRlZCcsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC1ub3RlLWNhcHR1cmUtJykpO1xuICAgIHRyeSB7XG4gICAgICBta2RpclN5bmMoam9pbihiYXNlLCAnLmdzZCcpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCAnLmdzZCcsICdDQVBUVVJFUy5tZCcpLCBbXG4gICAgICAgICcjIENhcHR1cmVzJyxcbiAgICAgICAgJycsXG4gICAgICAgICcjIyMgY2FwLW5vdGUnLFxuICAgICAgICAnKipUZXh0OioqIFJlbWVtYmVyIHRoaXMnLFxuICAgICAgICAnKipDYXB0dXJlZDoqKiAyMDI2LTAxLTAxVDAwOjAwOjAwLjAwMFonLFxuICAgICAgICAnKipTdGF0dXM6KiogcmVzb2x2ZWQnLFxuICAgICAgICAnKipDbGFzc2lmaWNhdGlvbjoqKiBub3RlJyxcbiAgICAgICAgJyoqUmVzb2x1dGlvbjoqKiBpbmZvcm1hdGlvbmFsIG9ubHknLFxuICAgICAgICAnKipSZXNvbHZlZDoqKiAyMDI2LTAxLTAxVDAwOjAxOjAwLjAwMFonLFxuICAgICAgICAnJyxcbiAgICAgIF0uam9pbignXFxuJykpO1xuXG4gICAgICBjb25zdCByZXN1bHQgPSBleGVjdXRlVHJpYWdlUmVzb2x1dGlvbnMoYmFzZSwgJ00wMDEnLCAnUzAxJyk7XG4gICAgICBjb25zdCBbY2FwdHVyZV0gPSBsb2FkQWxsQ2FwdHVyZXMoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuaW5qZWN0ZWQsIDApO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5yZXBsYW5uZWQsIDApO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5hY3Rpb25zLnNvbWUoKGFjdGlvbikgPT4gYWN0aW9uLmluY2x1ZGVzKCdOb3RlIGFja25vd2xlZGdlZDogY2FwLW5vdGUnKSkpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGNhcHR1cmU/LmV4ZWN1dGVkLCB0cnVlKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFZQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxXQUFXLGFBQWEsUUFBUSxxQkFBcUI7QUFDOUQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QixTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLGdDQUFnQztBQUV6QyxTQUFTLHVEQUF1RCxNQUFNO0FBQ3BFLE9BQUssK0NBQStDLE1BQU07QUFDeEQsVUFBTSxPQUFPLFlBQVksS0FBSyxPQUFPLEdBQUcsbUJBQW1CLENBQUM7QUFDNUQsUUFBSTtBQUNGLGdCQUFVLEtBQUssTUFBTSxNQUFNLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNqRCxvQkFBYyxLQUFLLE1BQU0sUUFBUSxhQUFhLEdBQUc7QUFBQSxRQUMvQztBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0YsRUFBRSxLQUFLLElBQUksQ0FBQztBQUVaLFlBQU0sU0FBUyx5QkFBeUIsTUFBTSxRQUFRLEtBQUs7QUFDM0QsWUFBTSxDQUFDLE9BQU8sSUFBSSxnQkFBZ0IsSUFBSTtBQUV0QyxhQUFPLE1BQU0sT0FBTyxVQUFVLENBQUM7QUFDL0IsYUFBTyxNQUFNLE9BQU8sV0FBVyxDQUFDO0FBQ2hDLGFBQU8sR0FBRyxPQUFPLFFBQVEsS0FBSyxDQUFDLFdBQVcsT0FBTyxTQUFTLDZCQUE2QixDQUFDLENBQUM7QUFDekYsYUFBTyxNQUFNLFNBQVMsVUFBVSxJQUFJO0FBQUEsSUFDdEMsVUFBRTtBQUNBLGFBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQy9DO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
