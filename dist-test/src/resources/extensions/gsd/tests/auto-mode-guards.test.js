import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parkMilestone, unparkMilestone, discardMilestone } from "../milestone-actions.js";
import { _setAutoActiveForTest } from "../auto.js";
function createFixture() {
  const base = mkdtempSync(join(tmpdir(), "gsd-guard-test-"));
  const mDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(mDir, { recursive: true });
  writeFileSync(join(mDir, "M001-ROADMAP.md"), "# M001\n", "utf-8");
  return base;
}
describe("auto-mode guards (milestone-actions)", () => {
  afterEach(() => {
    _setAutoActiveForTest(false);
  });
  test("parkMilestone throws when auto-mode is active", () => {
    const base = createFixture();
    try {
      _setAutoActiveForTest(true);
      assert.throws(
        () => parkMilestone(base, "M001", "test"),
        /auto-mode is active/
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("unparkMilestone throws when auto-mode is active", () => {
    const base = createFixture();
    try {
      _setAutoActiveForTest(true);
      assert.throws(
        () => unparkMilestone(base, "M001"),
        /auto-mode is active/
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("discardMilestone throws when auto-mode is active", () => {
    const base = createFixture();
    try {
      _setAutoActiveForTest(true);
      assert.throws(
        () => discardMilestone(base, "M001"),
        /auto-mode is active/
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("parkMilestone proceeds normally when auto-mode is inactive", () => {
    const base = createFixture();
    try {
      _setAutoActiveForTest(false);
      const result = parkMilestone(base, "M001", "baseline");
      assert.ok(result, "park succeeds when auto is inactive");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hdXRvLW1vZGUtZ3VhcmRzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUmVncmVzc2lvbiB0ZXN0cyBmb3IgYXV0by1tb2RlIGd1YXJkcyAoIzQ3MDQgVGllciAyIC8gIzQ3MTIpLlxuICpcbiAqIFZhbGlkYXRlcyB0aGUgZGVmZW5zZS1pbi1kZXB0aCB3cml0ZXIgYXNzZXJ0cyBpbiBtaWxlc3RvbmUtYWN0aW9ucy50cyBcdTIwMTRcbiAqIHBhcmtNaWxlc3RvbmUsIHVucGFya01pbGVzdG9uZSwgYW5kIGRpc2NhcmRNaWxlc3RvbmUgbXVzdCByZWZ1c2UgdG8gcnVuXG4gKiB3aGlsZSBhdXRvLW1vZGUgaXMgYWN0aXZlLCByZWdhcmRsZXNzIG9mIHRoZSBjYWxsaW5nIGRpc3BhdGNoIHBhdGguXG4gKi9cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0LCBhZnRlckVhY2ggfSBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gJ25vZGU6b3MnO1xuXG5pbXBvcnQgeyBwYXJrTWlsZXN0b25lLCB1bnBhcmtNaWxlc3RvbmUsIGRpc2NhcmRNaWxlc3RvbmUgfSBmcm9tICcuLi9taWxlc3RvbmUtYWN0aW9ucy50cyc7XG5pbXBvcnQgeyBfc2V0QXV0b0FjdGl2ZUZvclRlc3QgfSBmcm9tICcuLi9hdXRvLnRzJztcblxuZnVuY3Rpb24gY3JlYXRlRml4dHVyZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC1ndWFyZC10ZXN0LScpKTtcbiAgY29uc3QgbURpciA9IGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJyk7XG4gIG1rZGlyU3luYyhtRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKG1EaXIsICdNMDAxLVJPQURNQVAubWQnKSwgJyMgTTAwMVxcbicsICd1dGYtOCcpO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZGVzY3JpYmUoJ2F1dG8tbW9kZSBndWFyZHMgKG1pbGVzdG9uZS1hY3Rpb25zKScsICgpID0+IHtcbiAgYWZ0ZXJFYWNoKCgpID0+IHtcbiAgICBfc2V0QXV0b0FjdGl2ZUZvclRlc3QoZmFsc2UpO1xuICB9KTtcblxuICB0ZXN0KCdwYXJrTWlsZXN0b25lIHRocm93cyB3aGVuIGF1dG8tbW9kZSBpcyBhY3RpdmUnLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmUoKTtcbiAgICB0cnkge1xuICAgICAgX3NldEF1dG9BY3RpdmVGb3JUZXN0KHRydWUpO1xuICAgICAgYXNzZXJ0LnRocm93cyhcbiAgICAgICAgKCkgPT4gcGFya01pbGVzdG9uZShiYXNlLCAnTTAwMScsICd0ZXN0JyksXG4gICAgICAgIC9hdXRvLW1vZGUgaXMgYWN0aXZlLyxcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KCd1bnBhcmtNaWxlc3RvbmUgdGhyb3dzIHdoZW4gYXV0by1tb2RlIGlzIGFjdGl2ZScsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZSgpO1xuICAgIHRyeSB7XG4gICAgICBfc2V0QXV0b0FjdGl2ZUZvclRlc3QodHJ1ZSk7XG4gICAgICBhc3NlcnQudGhyb3dzKFxuICAgICAgICAoKSA9PiB1bnBhcmtNaWxlc3RvbmUoYmFzZSwgJ00wMDEnKSxcbiAgICAgICAgL2F1dG8tbW9kZSBpcyBhY3RpdmUvLFxuICAgICAgKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoJ2Rpc2NhcmRNaWxlc3RvbmUgdGhyb3dzIHdoZW4gYXV0by1tb2RlIGlzIGFjdGl2ZScsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZSgpO1xuICAgIHRyeSB7XG4gICAgICBfc2V0QXV0b0FjdGl2ZUZvclRlc3QodHJ1ZSk7XG4gICAgICBhc3NlcnQudGhyb3dzKFxuICAgICAgICAoKSA9PiBkaXNjYXJkTWlsZXN0b25lKGJhc2UsICdNMDAxJyksXG4gICAgICAgIC9hdXRvLW1vZGUgaXMgYWN0aXZlLyxcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KCdwYXJrTWlsZXN0b25lIHByb2NlZWRzIG5vcm1hbGx5IHdoZW4gYXV0by1tb2RlIGlzIGluYWN0aXZlJywgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlKCk7XG4gICAgdHJ5IHtcbiAgICAgIF9zZXRBdXRvQWN0aXZlRm9yVGVzdChmYWxzZSk7XG4gICAgICBjb25zdCByZXN1bHQgPSBwYXJrTWlsZXN0b25lKGJhc2UsICdNMDAxJywgJ2Jhc2VsaW5lJyk7XG4gICAgICBhc3NlcnQub2socmVzdWx0LCAncGFyayBzdWNjZWVkcyB3aGVuIGF1dG8gaXMgaW5hY3RpdmUnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFPQSxTQUFTLFVBQVUsTUFBTSxpQkFBaUI7QUFDMUMsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEscUJBQXFCO0FBQzlELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUyxlQUFlLGlCQUFpQix3QkFBd0I7QUFDakUsU0FBUyw2QkFBNkI7QUFFdEMsU0FBUyxnQkFBd0I7QUFDL0IsUUFBTSxPQUFPLFlBQVksS0FBSyxPQUFPLEdBQUcsaUJBQWlCLENBQUM7QUFDMUQsUUFBTSxPQUFPLEtBQUssTUFBTSxRQUFRLGNBQWMsTUFBTTtBQUNwRCxZQUFVLE1BQU0sRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNuQyxnQkFBYyxLQUFLLE1BQU0saUJBQWlCLEdBQUcsWUFBWSxPQUFPO0FBQ2hFLFNBQU87QUFDVDtBQUVBLFNBQVMsd0NBQXdDLE1BQU07QUFDckQsWUFBVSxNQUFNO0FBQ2QsMEJBQXNCLEtBQUs7QUFBQSxFQUM3QixDQUFDO0FBRUQsT0FBSyxpREFBaUQsTUFBTTtBQUMxRCxVQUFNLE9BQU8sY0FBYztBQUMzQixRQUFJO0FBQ0YsNEJBQXNCLElBQUk7QUFDMUIsYUFBTztBQUFBLFFBQ0wsTUFBTSxjQUFjLE1BQU0sUUFBUSxNQUFNO0FBQUEsUUFDeEM7QUFBQSxNQUNGO0FBQUEsSUFDRixVQUFFO0FBQ0EsYUFBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDL0M7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLG1EQUFtRCxNQUFNO0FBQzVELFVBQU0sT0FBTyxjQUFjO0FBQzNCLFFBQUk7QUFDRiw0QkFBc0IsSUFBSTtBQUMxQixhQUFPO0FBQUEsUUFDTCxNQUFNLGdCQUFnQixNQUFNLE1BQU07QUFBQSxRQUNsQztBQUFBLE1BQ0Y7QUFBQSxJQUNGLFVBQUU7QUFDQSxhQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUMvQztBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssb0RBQW9ELE1BQU07QUFDN0QsVUFBTSxPQUFPLGNBQWM7QUFDM0IsUUFBSTtBQUNGLDRCQUFzQixJQUFJO0FBQzFCLGFBQU87QUFBQSxRQUNMLE1BQU0saUJBQWlCLE1BQU0sTUFBTTtBQUFBLFFBQ25DO0FBQUEsTUFDRjtBQUFBLElBQ0YsVUFBRTtBQUNBLGFBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQy9DO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyw4REFBOEQsTUFBTTtBQUN2RSxVQUFNLE9BQU8sY0FBYztBQUMzQixRQUFJO0FBQ0YsNEJBQXNCLEtBQUs7QUFDM0IsWUFBTSxTQUFTLGNBQWMsTUFBTSxRQUFRLFVBQVU7QUFDckQsYUFBTyxHQUFHLFFBQVEscUNBQXFDO0FBQUEsSUFDekQsVUFBRTtBQUNBLGFBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQy9DO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
