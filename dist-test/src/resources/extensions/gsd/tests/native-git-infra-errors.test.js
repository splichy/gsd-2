import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./test-utils.js";
import { GSD_GIT_ERROR } from "../errors.js";
test("nativeAddAllWithExclusions preserves infrastructure failures from git add", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-native-git-infra-"));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  const fakeGit = join(bin, "git");
  writeFileSync(
    fakeGit,
    "#!/bin/sh\necho 'fatal: ENFILE: file table overflow' >&2\nexit 1\n",
    "utf-8"
  );
  chmodSync(fakeGit, 493);
  const originalPath = process.env.PATH ?? "";
  try {
    git(repo, "init");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    writeFileSync(join(repo, "README.md"), "# Test\n", "utf-8");
    process.env.PATH = `${bin}:${originalPath}`;
    const { nativeAddAllWithExclusions } = await import("../native-git-bridge.js");
    assert.throws(
      () => nativeAddAllWithExclusions(repo, [".gsd/activity/"]),
      (err) => {
        const shaped = err;
        assert.notEqual(shaped.code, GSD_GIT_ERROR);
        assert.match(`${shaped.stderr ?? ""}${shaped.message ?? ""}`, /ENFILE/);
        return true;
      }
    );
  } finally {
    process.env.PATH = originalPath;
    rmSync(base, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9uYXRpdmUtZ2l0LWluZnJhLWVycm9ycy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGNobW9kU3luYywgbWtkaXJTeW5jLCBta2R0ZW1wU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5pbXBvcnQgeyBnaXQgfSBmcm9tIFwiLi90ZXN0LXV0aWxzLnRzXCI7XG5pbXBvcnQgeyBHU0RfR0lUX0VSUk9SIH0gZnJvbSBcIi4uL2Vycm9ycy5qc1wiO1xuXG50ZXN0KFwibmF0aXZlQWRkQWxsV2l0aEV4Y2x1c2lvbnMgcHJlc2VydmVzIGluZnJhc3RydWN0dXJlIGZhaWx1cmVzIGZyb20gZ2l0IGFkZFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1uYXRpdmUtZ2l0LWluZnJhLVwiKSk7XG4gIGNvbnN0IHJlcG8gPSBqb2luKGJhc2UsIFwicmVwb1wiKTtcbiAgY29uc3QgYmluID0gam9pbihiYXNlLCBcImJpblwiKTtcbiAgbWtkaXJTeW5jKHJlcG8pO1xuICBta2RpclN5bmMoYmluKTtcblxuICBjb25zdCBmYWtlR2l0ID0gam9pbihiaW4sIFwiZ2l0XCIpO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGZha2VHaXQsXG4gICAgXCIjIS9iaW4vc2hcXG5cIiArXG4gICAgICBcImVjaG8gJ2ZhdGFsOiBFTkZJTEU6IGZpbGUgdGFibGUgb3ZlcmZsb3cnID4mMlxcblwiICtcbiAgICAgIFwiZXhpdCAxXFxuXCIsXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuICBjaG1vZFN5bmMoZmFrZUdpdCwgMG83NTUpO1xuXG4gIGNvbnN0IG9yaWdpbmFsUGF0aCA9IHByb2Nlc3MuZW52LlBBVEggPz8gXCJcIjtcbiAgdHJ5IHtcbiAgICBnaXQocmVwbywgXCJpbml0XCIpO1xuICAgIGdpdChyZXBvLCBcImNvbmZpZ1wiLCBcInVzZXIuZW1haWxcIiwgXCJ0ZXN0QGV4YW1wbGUuY29tXCIpO1xuICAgIGdpdChyZXBvLCBcImNvbmZpZ1wiLCBcInVzZXIubmFtZVwiLCBcIlRlc3QgVXNlclwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocmVwbywgXCJSRUFETUUubWRcIiksIFwiIyBUZXN0XFxuXCIsIFwidXRmLThcIik7XG5cbiAgICBwcm9jZXNzLmVudi5QQVRIID0gYCR7YmlufToke29yaWdpbmFsUGF0aH1gO1xuICAgIGNvbnN0IHsgbmF0aXZlQWRkQWxsV2l0aEV4Y2x1c2lvbnMgfSA9IGF3YWl0IGltcG9ydChcIi4uL25hdGl2ZS1naXQtYnJpZGdlLnRzXCIpO1xuXG4gICAgYXNzZXJ0LnRocm93cyhcbiAgICAgICgpID0+IG5hdGl2ZUFkZEFsbFdpdGhFeGNsdXNpb25zKHJlcG8sIFtcIi5nc2QvYWN0aXZpdHkvXCJdKSxcbiAgICAgIChlcnIpID0+IHtcbiAgICAgICAgY29uc3Qgc2hhcGVkID0gZXJyIGFzIHsgY29kZT86IHN0cmluZzsgc3RkZXJyPzogc3RyaW5nOyBtZXNzYWdlPzogc3RyaW5nIH07XG4gICAgICAgIGFzc2VydC5ub3RFcXVhbChzaGFwZWQuY29kZSwgR1NEX0dJVF9FUlJPUik7XG4gICAgICAgIGFzc2VydC5tYXRjaChgJHtzaGFwZWQuc3RkZXJyID8/IFwiXCJ9JHtzaGFwZWQubWVzc2FnZSA/PyBcIlwifWAsIC9FTkZJTEUvKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9LFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgcHJvY2Vzcy5lbnYuUEFUSCA9IG9yaWdpbmFsUGF0aDtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxXQUFXLFdBQVcsYUFBYSxRQUFRLHFCQUFxQjtBQUN6RSxTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBRXJCLFNBQVMsV0FBVztBQUNwQixTQUFTLHFCQUFxQjtBQUU5QixLQUFLLDZFQUE2RSxZQUFZO0FBQzVGLFFBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLHVCQUF1QixDQUFDO0FBQ2hFLFFBQU0sT0FBTyxLQUFLLE1BQU0sTUFBTTtBQUM5QixRQUFNLE1BQU0sS0FBSyxNQUFNLEtBQUs7QUFDNUIsWUFBVSxJQUFJO0FBQ2QsWUFBVSxHQUFHO0FBRWIsUUFBTSxVQUFVLEtBQUssS0FBSyxLQUFLO0FBQy9CO0FBQUEsSUFDRTtBQUFBLElBQ0E7QUFBQSxJQUdBO0FBQUEsRUFDRjtBQUNBLFlBQVUsU0FBUyxHQUFLO0FBRXhCLFFBQU0sZUFBZSxRQUFRLElBQUksUUFBUTtBQUN6QyxNQUFJO0FBQ0YsUUFBSSxNQUFNLE1BQU07QUFDaEIsUUFBSSxNQUFNLFVBQVUsY0FBYyxrQkFBa0I7QUFDcEQsUUFBSSxNQUFNLFVBQVUsYUFBYSxXQUFXO0FBQzVDLGtCQUFjLEtBQUssTUFBTSxXQUFXLEdBQUcsWUFBWSxPQUFPO0FBRTFELFlBQVEsSUFBSSxPQUFPLEdBQUcsR0FBRyxJQUFJLFlBQVk7QUFDekMsVUFBTSxFQUFFLDJCQUEyQixJQUFJLE1BQU0sT0FBTyx5QkFBeUI7QUFFN0UsV0FBTztBQUFBLE1BQ0wsTUFBTSwyQkFBMkIsTUFBTSxDQUFDLGdCQUFnQixDQUFDO0FBQUEsTUFDekQsQ0FBQyxRQUFRO0FBQ1AsY0FBTSxTQUFTO0FBQ2YsZUFBTyxTQUFTLE9BQU8sTUFBTSxhQUFhO0FBQzFDLGVBQU8sTUFBTSxHQUFHLE9BQU8sVUFBVSxFQUFFLEdBQUcsT0FBTyxXQUFXLEVBQUUsSUFBSSxRQUFRO0FBQ3RFLGVBQU87QUFBQSxNQUNUO0FBQUEsSUFDRjtBQUFBLEVBQ0YsVUFBRTtBQUNBLFlBQVEsSUFBSSxPQUFPO0FBQ25CLFdBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQy9DO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
