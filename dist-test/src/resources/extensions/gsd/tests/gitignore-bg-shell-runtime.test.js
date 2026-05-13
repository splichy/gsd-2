import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureGitignore } from "../gitignore.js";
function makeTmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gsd-gitignore-bg-"));
}
function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
  }
}
describe("ensureGitignore writes .bg-shell/ baseline (#4902)", () => {
  test("appends .bg-shell/ to a fresh project .gitignore", () => {
    const dir = makeTmpRepo();
    try {
      const wrote = ensureGitignore(dir);
      assert.equal(wrote, true, "ensureGitignore should report it wrote");
      const ignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf-8");
      const lines = new Set(
        ignore.split("\n").map((l) => l.trim()).filter(Boolean)
      );
      assert.ok(
        lines.has(".bg-shell/"),
        `.gitignore should include .bg-shell/. Got:
${ignore}`
      );
    } finally {
      cleanup(dir);
    }
  });
  test("preserves .bg-shell/ when it is already present (idempotent)", () => {
    const dir = makeTmpRepo();
    try {
      fs.writeFileSync(
        path.join(dir, ".gitignore"),
        ".bg-shell/\nnode_modules/\n"
      );
      ensureGitignore(dir);
      const ignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf-8");
      const occurrences = ignore.split("\n").filter((l) => l.trim() === ".bg-shell/").length;
      assert.equal(occurrences, 1, "should not duplicate an existing .bg-shell/ entry");
    } finally {
      cleanup(dir);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9naXRpZ25vcmUtYmctc2hlbGwtcnVudGltZS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJ1bnRpbWUgcmVncmVzc2lvbiBcdTIwMTQgYC5iZy1zaGVsbC9gIGJhc2VsaW5lIHBhdHRlcm4gKCM0OTAyLCBwcmlvciAjMjY1NSkuXG4gKlxuICogVGhlIGRlbGV0ZWQgYGdpdGlnbm9yZS1iZy1zaGVsbC50ZXN0LnRzYCBhc3NlcnRlZCBgLmJnLXNoZWxsL2AgYXBwZWFyZWQgaW5cbiAqIHRoZSBCQVNFTElORV9QQVRURVJOUyBhcnJheSB2aWEgc291cmNlIGdyZXAuIFRoaXMgcmV3cml0ZSBkcml2ZXNcbiAqIGBlbnN1cmVHaXRpZ25vcmUoKWAgYWdhaW5zdCBhIHRtcCBkaXJlY3RvcnkgYW5kIGFzc2VydHMgdGhlIHdyaXR0ZW5cbiAqIGAuZ2l0aWdub3JlYCBhY3R1YWxseSBjb250YWlucyB0aGUgYC5iZy1zaGVsbC9gIHBhdHRlcm4gXHUyMDE0IGkuZS4gdGVzdHMgdGhlXG4gKiBiZWhhdmlvdXIgdGhlIGNvbnN0YW50IGV4aXN0cyB0byBndWFyYW50ZWUsIG5vdCB0aGUgc3BlbGxpbmcgb2YgdGhlXG4gKiBjb25zdGFudC5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgKiBhcyBmcyBmcm9tICdub2RlOmZzJztcbmltcG9ydCAqIGFzIG9zIGZyb20gJ25vZGU6b3MnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdub2RlOnBhdGgnO1xuXG5pbXBvcnQgeyBlbnN1cmVHaXRpZ25vcmUgfSBmcm9tICcuLi9naXRpZ25vcmUudHMnO1xuXG5mdW5jdGlvbiBtYWtlVG1wUmVwbygpOiBzdHJpbmcge1xuICByZXR1cm4gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKG9zLnRtcGRpcigpLCAnZ3NkLWdpdGlnbm9yZS1iZy0nKSk7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoZGlyOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHsgZnMucm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHsgLyogc3dhbGxvdyAqLyB9XG59XG5cbmRlc2NyaWJlKCdlbnN1cmVHaXRpZ25vcmUgd3JpdGVzIC5iZy1zaGVsbC8gYmFzZWxpbmUgKCM0OTAyKScsICgpID0+IHtcbiAgdGVzdCgnYXBwZW5kcyAuYmctc2hlbGwvIHRvIGEgZnJlc2ggcHJvamVjdCAuZ2l0aWdub3JlJywgKCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IG1ha2VUbXBSZXBvKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHdyb3RlID0gZW5zdXJlR2l0aWdub3JlKGRpcik7XG4gICAgICBhc3NlcnQuZXF1YWwod3JvdGUsIHRydWUsICdlbnN1cmVHaXRpZ25vcmUgc2hvdWxkIHJlcG9ydCBpdCB3cm90ZScpO1xuXG4gICAgICBjb25zdCBpZ25vcmUgPSBmcy5yZWFkRmlsZVN5bmMocGF0aC5qb2luKGRpciwgJy5naXRpZ25vcmUnKSwgJ3V0Zi04Jyk7XG4gICAgICBjb25zdCBsaW5lcyA9IG5ldyBTZXQoXG4gICAgICAgIGlnbm9yZS5zcGxpdCgnXFxuJykubWFwKChsKSA9PiBsLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgbGluZXMuaGFzKCcuYmctc2hlbGwvJyksXG4gICAgICAgIGAuZ2l0aWdub3JlIHNob3VsZCBpbmNsdWRlIC5iZy1zaGVsbC8uIEdvdDpcXG4ke2lnbm9yZX1gLFxuICAgICAgKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChkaXIpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdCgncHJlc2VydmVzIC5iZy1zaGVsbC8gd2hlbiBpdCBpcyBhbHJlYWR5IHByZXNlbnQgKGlkZW1wb3RlbnQpJywgKCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IG1ha2VUbXBSZXBvKCk7XG4gICAgdHJ5IHtcbiAgICAgIGZzLndyaXRlRmlsZVN5bmMoXG4gICAgICAgIHBhdGguam9pbihkaXIsICcuZ2l0aWdub3JlJyksXG4gICAgICAgICcuYmctc2hlbGwvXFxubm9kZV9tb2R1bGVzL1xcbicsXG4gICAgICApO1xuICAgICAgZW5zdXJlR2l0aWdub3JlKGRpcik7IC8vIHJ1biBvbmNlIHRvIGZpbGwgbWlzc2luZyBiYXNlbGluZVxuICAgICAgY29uc3QgaWdub3JlID0gZnMucmVhZEZpbGVTeW5jKHBhdGguam9pbihkaXIsICcuZ2l0aWdub3JlJyksICd1dGYtOCcpO1xuICAgICAgY29uc3Qgb2NjdXJyZW5jZXMgPSBpZ25vcmUuc3BsaXQoJ1xcbicpLmZpbHRlcigobCkgPT4gbC50cmltKCkgPT09ICcuYmctc2hlbGwvJykubGVuZ3RoO1xuICAgICAgYXNzZXJ0LmVxdWFsKG9jY3VycmVuY2VzLCAxLCAnc2hvdWxkIG5vdCBkdXBsaWNhdGUgYW4gZXhpc3RpbmcgLmJnLXNoZWxsLyBlbnRyeScpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGRpcik7XG4gICAgfVxuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBV0EsU0FBUyxVQUFVLFlBQVk7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLFlBQVksUUFBUTtBQUNwQixZQUFZLFFBQVE7QUFDcEIsWUFBWSxVQUFVO0FBRXRCLFNBQVMsdUJBQXVCO0FBRWhDLFNBQVMsY0FBc0I7QUFDN0IsU0FBTyxHQUFHLFlBQVksS0FBSyxLQUFLLEdBQUcsT0FBTyxHQUFHLG1CQUFtQixDQUFDO0FBQ25FO0FBRUEsU0FBUyxRQUFRLEtBQW1CO0FBQ2xDLE1BQUk7QUFBRSxPQUFHLE9BQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQUcsUUFBUTtBQUFBLEVBQWdCO0FBQ2xGO0FBRUEsU0FBUyxzREFBc0QsTUFBTTtBQUNuRSxPQUFLLG9EQUFvRCxNQUFNO0FBQzdELFVBQU0sTUFBTSxZQUFZO0FBQ3hCLFFBQUk7QUFDRixZQUFNLFFBQVEsZ0JBQWdCLEdBQUc7QUFDakMsYUFBTyxNQUFNLE9BQU8sTUFBTSx3Q0FBd0M7QUFFbEUsWUFBTSxTQUFTLEdBQUcsYUFBYSxLQUFLLEtBQUssS0FBSyxZQUFZLEdBQUcsT0FBTztBQUNwRSxZQUFNLFFBQVEsSUFBSTtBQUFBLFFBQ2hCLE9BQU8sTUFBTSxJQUFJLEVBQUUsSUFBSSxDQUFDLE1BQU0sRUFBRSxLQUFLLENBQUMsRUFBRSxPQUFPLE9BQU87QUFBQSxNQUN4RDtBQUNBLGFBQU87QUFBQSxRQUNMLE1BQU0sSUFBSSxZQUFZO0FBQUEsUUFDdEI7QUFBQSxFQUErQyxNQUFNO0FBQUEsTUFDdkQ7QUFBQSxJQUNGLFVBQUU7QUFDQSxjQUFRLEdBQUc7QUFBQSxJQUNiO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyxnRUFBZ0UsTUFBTTtBQUN6RSxVQUFNLE1BQU0sWUFBWTtBQUN4QixRQUFJO0FBQ0YsU0FBRztBQUFBLFFBQ0QsS0FBSyxLQUFLLEtBQUssWUFBWTtBQUFBLFFBQzNCO0FBQUEsTUFDRjtBQUNBLHNCQUFnQixHQUFHO0FBQ25CLFlBQU0sU0FBUyxHQUFHLGFBQWEsS0FBSyxLQUFLLEtBQUssWUFBWSxHQUFHLE9BQU87QUFDcEUsWUFBTSxjQUFjLE9BQU8sTUFBTSxJQUFJLEVBQUUsT0FBTyxDQUFDLE1BQU0sRUFBRSxLQUFLLE1BQU0sWUFBWSxFQUFFO0FBQ2hGLGFBQU8sTUFBTSxhQUFhLEdBQUcsbURBQW1EO0FBQUEsSUFDbEYsVUFBRTtBQUNBLGNBQVEsR0FBRztBQUFBLElBQ2I7QUFBQSxFQUNGLENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
