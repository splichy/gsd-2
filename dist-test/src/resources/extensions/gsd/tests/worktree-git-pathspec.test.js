import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { _gitPathspecForWorktreePath } from "../auto-worktree.js";
function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}
describe("worktree git pathspec", () => {
  test("skips external GSD bookkeeping directories outside the git work-tree", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-pathspec-")));
    const repo = join(root, "project");
    const externalGsd = join(root, ".gsd", "projects", "abc123");
    try {
      mkdirSync(repo, { recursive: true });
      mkdirSync(join(externalGsd, "milestones", "M002-wa00fm"), { recursive: true });
      mkdirSync(join(externalGsd, "runtime", "units"), { recursive: true });
      run("git", ["init"], repo);
      writeFileSync(join(repo, "README.md"), "# test\n");
      assert.equal(
        _gitPathspecForWorktreePath(repo, join(externalGsd, "milestones", "M002-wa00fm")),
        null
      );
      assert.equal(
        _gitPathspecForWorktreePath(repo, join(externalGsd, "runtime", "units")),
        null
      );
    } finally {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrdHJlZS1naXQtcGF0aHNwZWMudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYywgZXhpc3RzU3luYywgcmVhbHBhdGhTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZXhlY0ZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuXG5pbXBvcnQgeyBfZ2l0UGF0aHNwZWNGb3JXb3JrdHJlZVBhdGggfSBmcm9tIFwiLi4vYXV0by13b3JrdHJlZS50c1wiO1xuXG5mdW5jdGlvbiBydW4oY21kOiBzdHJpbmcsIGFyZ3M6IHN0cmluZ1tdLCBjd2Q6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBleGVjRmlsZVN5bmMoY21kLCBhcmdzLCB7IGN3ZCwgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLCBlbmNvZGluZzogXCJ1dGYtOFwiIH0pLnRyaW0oKTtcbn1cblxuZGVzY3JpYmUoXCJ3b3JrdHJlZSBnaXQgcGF0aHNwZWNcIiwgKCkgPT4ge1xuICB0ZXN0KFwic2tpcHMgZXh0ZXJuYWwgR1NEIGJvb2trZWVwaW5nIGRpcmVjdG9yaWVzIG91dHNpZGUgdGhlIGdpdCB3b3JrLXRyZWVcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJvb3QgPSByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcGF0aHNwZWMtXCIpKSk7XG4gICAgY29uc3QgcmVwbyA9IGpvaW4ocm9vdCwgXCJwcm9qZWN0XCIpO1xuICAgIGNvbnN0IGV4dGVybmFsR3NkID0gam9pbihyb290LCBcIi5nc2RcIiwgXCJwcm9qZWN0c1wiLCBcImFiYzEyM1wiKTtcblxuICAgIHRyeSB7XG4gICAgICBta2RpclN5bmMocmVwbywgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBta2RpclN5bmMoam9pbihleHRlcm5hbEdzZCwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMi13YTAwZm1cIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgbWtkaXJTeW5jKGpvaW4oZXh0ZXJuYWxHc2QsIFwicnVudGltZVwiLCBcInVuaXRzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHJ1bihcImdpdFwiLCBbXCJpbml0XCJdLCByZXBvKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXBvLCBcIlJFQURNRS5tZFwiKSwgXCIjIHRlc3RcXG5cIik7XG5cbiAgICAgIGFzc2VydC5lcXVhbChcbiAgICAgICAgX2dpdFBhdGhzcGVjRm9yV29ya3RyZWVQYXRoKHJlcG8sIGpvaW4oZXh0ZXJuYWxHc2QsIFwibWlsZXN0b25lc1wiLCBcIk0wMDItd2EwMGZtXCIpKSxcbiAgICAgICAgbnVsbCxcbiAgICAgICk7XG4gICAgICBhc3NlcnQuZXF1YWwoXG4gICAgICAgIF9naXRQYXRoc3BlY0Zvcldvcmt0cmVlUGF0aChyZXBvLCBqb2luKGV4dGVybmFsR3NkLCBcInJ1bnRpbWVcIiwgXCJ1bml0c1wiKSksXG4gICAgICAgIG51bGwsXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBpZiAoZXhpc3RzU3luYyhyb290KSkgcm1TeW5jKHJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsUUFBUSxlQUFlLFlBQVksb0JBQW9CO0FBQ3hGLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxvQkFBb0I7QUFFN0IsU0FBUyxtQ0FBbUM7QUFFNUMsU0FBUyxJQUFJLEtBQWEsTUFBZ0IsS0FBcUI7QUFDN0QsU0FBTyxhQUFhLEtBQUssTUFBTSxFQUFFLEtBQUssT0FBTyxDQUFDLFVBQVUsUUFBUSxNQUFNLEdBQUcsVUFBVSxRQUFRLENBQUMsRUFBRSxLQUFLO0FBQ3JHO0FBRUEsU0FBUyx5QkFBeUIsTUFBTTtBQUN0QyxPQUFLLHdFQUF3RSxNQUFNO0FBQ2pGLFVBQU0sT0FBTyxhQUFhLFlBQVksS0FBSyxPQUFPLEdBQUcsZUFBZSxDQUFDLENBQUM7QUFDdEUsVUFBTSxPQUFPLEtBQUssTUFBTSxTQUFTO0FBQ2pDLFVBQU0sY0FBYyxLQUFLLE1BQU0sUUFBUSxZQUFZLFFBQVE7QUFFM0QsUUFBSTtBQUNGLGdCQUFVLE1BQU0sRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNuQyxnQkFBVSxLQUFLLGFBQWEsY0FBYyxhQUFhLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUM3RSxnQkFBVSxLQUFLLGFBQWEsV0FBVyxPQUFPLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNwRSxVQUFJLE9BQU8sQ0FBQyxNQUFNLEdBQUcsSUFBSTtBQUN6QixvQkFBYyxLQUFLLE1BQU0sV0FBVyxHQUFHLFVBQVU7QUFFakQsYUFBTztBQUFBLFFBQ0wsNEJBQTRCLE1BQU0sS0FBSyxhQUFhLGNBQWMsYUFBYSxDQUFDO0FBQUEsUUFDaEY7QUFBQSxNQUNGO0FBQ0EsYUFBTztBQUFBLFFBQ0wsNEJBQTRCLE1BQU0sS0FBSyxhQUFhLFdBQVcsT0FBTyxDQUFDO0FBQUEsUUFDdkU7QUFBQSxNQUNGO0FBQUEsSUFDRixVQUFFO0FBQ0EsVUFBSSxXQUFXLElBQUksRUFBRyxRQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUNyRTtBQUFBLEVBQ0YsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
