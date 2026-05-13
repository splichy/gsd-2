import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  realpathSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { migrateToExternalState } from "../migrate-external.js";
function run(command, cwd) {
  return execSync(command, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8"
  }).trim();
}
describe("migrate-external worktree guard (#2970)", () => {
  let base;
  let stateDir;
  let worktreePath;
  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-migrate-wt-")));
    stateDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-state-")));
    process.env.GSD_STATE_DIR = stateDir;
    run("git init -b main", base);
    run('git config user.name "Test"', base);
    run('git config user.email "test@example.com"', base);
    run("git remote add origin git@github.com:example/repo.git", base);
    writeFileSync(join(base, "README.md"), "# Test\n", "utf-8");
    run("git add README.md", base);
    run('git commit -m "init"', base);
    worktreePath = join(base, ".gsd", "worktrees", "M001");
    run(`git worktree add -b milestone/M001 ${worktreePath}`, base);
    const worktreeGsd = join(worktreePath, ".gsd");
    mkdirSync(worktreeGsd, { recursive: true });
    writeFileSync(join(worktreeGsd, "PREFERENCES.md"), "# prefs\n", "utf-8");
  });
  after(() => {
    delete process.env.GSD_STATE_DIR;
    try {
      run(`git worktree remove --force ${worktreePath}`, base);
    } catch {
    }
    rmSync(base, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });
  test("migrateToExternalState skips when basePath is a git worktree", () => {
    const result = migrateToExternalState(worktreePath);
    assert.equal(result.migrated, false, "should not migrate inside a worktree");
    assert.equal(result.error, void 0, "should not report an error");
    assert.ok(
      existsSync(join(worktreePath, ".gsd")),
      ".gsd directory should still exist after skipped migration"
    );
    assert.ok(
      !existsSync(join(worktreePath, ".gsd.migrating")),
      ".gsd.migrating should not be created in a worktree"
    );
  });
  test("migrateToExternalState still works on main repo", () => {
    const mainBase = realpathSync(mkdtempSync(join(tmpdir(), "gsd-migrate-main-")));
    try {
      run("git init -b main", mainBase);
      run('git config user.name "Test"', mainBase);
      run('git config user.email "test@example.com"', mainBase);
      run("git remote add origin git@github.com:example/main-repo.git", mainBase);
      writeFileSync(join(mainBase, "README.md"), "# Test\n", "utf-8");
      run("git add README.md", mainBase);
      run('git commit -m "init"', mainBase);
      mkdirSync(join(mainBase, ".gsd"), { recursive: true });
      writeFileSync(join(mainBase, ".gsd", "PREFERENCES.md"), "# prefs\n", "utf-8");
      const result = migrateToExternalState(mainBase);
      assert.equal(result.migrated, true, "should migrate on main repo");
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9taWdyYXRlLWV4dGVybmFsLXdvcmt0cmVlLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0LCBiZWZvcmUsIGFmdGVyIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQge1xuICBta2R0ZW1wU3luYyxcbiAgcm1TeW5jLFxuICB3cml0ZUZpbGVTeW5jLFxuICBleGlzdHNTeW5jLFxuICBta2RpclN5bmMsXG4gIHJlYWxwYXRoU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZXhlY1N5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5cbmltcG9ydCB7IG1pZ3JhdGVUb0V4dGVybmFsU3RhdGUgfSBmcm9tIFwiLi4vbWlncmF0ZS1leHRlcm5hbC50c1wiO1xuXG5mdW5jdGlvbiBydW4oY29tbWFuZDogc3RyaW5nLCBjd2Q6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBleGVjU3luYyhjb21tYW5kLCB7XG4gICAgY3dkLFxuICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcbiAgICBlbmNvZGluZzogXCJ1dGYtOFwiLFxuICB9KS50cmltKCk7XG59XG5cbmRlc2NyaWJlKFwibWlncmF0ZS1leHRlcm5hbCB3b3JrdHJlZSBndWFyZCAoIzI5NzApXCIsICgpID0+IHtcbiAgbGV0IGJhc2U6IHN0cmluZztcbiAgbGV0IHN0YXRlRGlyOiBzdHJpbmc7XG4gIGxldCB3b3JrdHJlZVBhdGg6IHN0cmluZztcblxuICBiZWZvcmUoKCkgPT4ge1xuICAgIGJhc2UgPSByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtbWlncmF0ZS13dC1cIikpKTtcbiAgICBzdGF0ZURpciA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1zdGF0ZS1cIikpKTtcbiAgICBwcm9jZXNzLmVudi5HU0RfU1RBVEVfRElSID0gc3RhdGVEaXI7XG5cbiAgICAvLyBDcmVhdGUgYSBnaXQgcmVwbyB3aXRoIGEgcmVtb3RlXG4gICAgcnVuKFwiZ2l0IGluaXQgLWIgbWFpblwiLCBiYXNlKTtcbiAgICBydW4oJ2dpdCBjb25maWcgdXNlci5uYW1lIFwiVGVzdFwiJywgYmFzZSk7XG4gICAgcnVuKCdnaXQgY29uZmlnIHVzZXIuZW1haWwgXCJ0ZXN0QGV4YW1wbGUuY29tXCInLCBiYXNlKTtcbiAgICBydW4oJ2dpdCByZW1vdGUgYWRkIG9yaWdpbiBnaXRAZ2l0aHViLmNvbTpleGFtcGxlL3JlcG8uZ2l0JywgYmFzZSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiUkVBRE1FLm1kXCIpLCBcIiMgVGVzdFxcblwiLCBcInV0Zi04XCIpO1xuICAgIHJ1bihcImdpdCBhZGQgUkVBRE1FLm1kXCIsIGJhc2UpO1xuICAgIHJ1bignZ2l0IGNvbW1pdCAtbSBcImluaXRcIicsIGJhc2UpO1xuXG4gICAgLy8gQ3JlYXRlIGEgd29ya3RyZWVcbiAgICB3b3JrdHJlZVBhdGggPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIndvcmt0cmVlc1wiLCBcIk0wMDFcIik7XG4gICAgcnVuKGBnaXQgd29ya3RyZWUgYWRkIC1iIG1pbGVzdG9uZS9NMDAxICR7d29ya3RyZWVQYXRofWAsIGJhc2UpO1xuXG4gICAgLy8gUG9wdWxhdGUgd29ya3RyZWUgd2l0aCBhIC5nc2QgZGlyZWN0b3J5IChzaW11bGF0aW5nIHN5bmNHc2RTdGF0ZVRvV29ya3RyZWUpXG4gICAgY29uc3Qgd29ya3RyZWVHc2QgPSBqb2luKHdvcmt0cmVlUGF0aCwgXCIuZ3NkXCIpO1xuICAgIG1rZGlyU3luYyh3b3JrdHJlZUdzZCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHdvcmt0cmVlR3NkLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLCBcIiMgcHJlZnNcXG5cIiwgXCJ1dGYtOFwiKTtcbiAgfSk7XG5cbiAgYWZ0ZXIoKCkgPT4ge1xuICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfU1RBVEVfRElSO1xuICAgIC8vIFJlbW92ZSB3b3JrdHJlZSBiZWZvcmUgY2xlYW5pbmcgdXBcbiAgICB0cnkgeyBydW4oYGdpdCB3b3JrdHJlZSByZW1vdmUgLS1mb3JjZSAke3dvcmt0cmVlUGF0aH1gLCBiYXNlKTsgfSBjYXRjaCB7IC8qIG9rICovIH1cbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIHJtU3luYyhzdGF0ZURpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICB0ZXN0KFwibWlncmF0ZVRvRXh0ZXJuYWxTdGF0ZSBza2lwcyB3aGVuIGJhc2VQYXRoIGlzIGEgZ2l0IHdvcmt0cmVlXCIsICgpID0+IHtcbiAgICAvLyBUaGUgd29ya3RyZWUgaGFzIGEgcmVhbCAuZ3NkIGRpcmVjdG9yeSBcdTIwMTQgbWlncmF0aW9uIHdvdWxkIG5vcm1hbGx5IHJ1bi5cbiAgICAvLyBCdXQgc2luY2UgdGhpcyBpcyBhIHdvcmt0cmVlLCBpdCBzaG91bGQgYmUgc2tpcHBlZC5cbiAgICBjb25zdCByZXN1bHQgPSBtaWdyYXRlVG9FeHRlcm5hbFN0YXRlKHdvcmt0cmVlUGF0aCk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1pZ3JhdGVkLCBmYWxzZSwgXCJzaG91bGQgbm90IG1pZ3JhdGUgaW5zaWRlIGEgd29ya3RyZWVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5lcnJvciwgdW5kZWZpbmVkLCBcInNob3VsZCBub3QgcmVwb3J0IGFuIGVycm9yXCIpO1xuXG4gICAgLy8gLmdzZCBzaG91bGQgc3RpbGwgZXhpc3QgYXMgYSByZWFsIGRpcmVjdG9yeSAobm90IHJlbmFtZWQvcmVtb3ZlZClcbiAgICBhc3NlcnQub2soXG4gICAgICBleGlzdHNTeW5jKGpvaW4od29ya3RyZWVQYXRoLCBcIi5nc2RcIikpLFxuICAgICAgXCIuZ3NkIGRpcmVjdG9yeSBzaG91bGQgc3RpbGwgZXhpc3QgYWZ0ZXIgc2tpcHBlZCBtaWdyYXRpb25cIlxuICAgICk7XG5cbiAgICAvLyAuZ3NkLm1pZ3JhdGluZyBzaG91bGQgTk9UIGV4aXN0XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgIWV4aXN0c1N5bmMoam9pbih3b3JrdHJlZVBhdGgsIFwiLmdzZC5taWdyYXRpbmdcIikpLFxuICAgICAgXCIuZ3NkLm1pZ3JhdGluZyBzaG91bGQgbm90IGJlIGNyZWF0ZWQgaW4gYSB3b3JrdHJlZVwiXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcIm1pZ3JhdGVUb0V4dGVybmFsU3RhdGUgc3RpbGwgd29ya3Mgb24gbWFpbiByZXBvXCIsICgpID0+IHtcbiAgICAvLyBDcmVhdGUgYSBmcmVzaCB0ZW1wIHJlcG8gdG8gdGVzdCBtYWluIHJlcG8gbWlncmF0aW9uIHBhdGhcbiAgICBjb25zdCBtYWluQmFzZSA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1taWdyYXRlLW1haW4tXCIpKSk7XG4gICAgdHJ5IHtcbiAgICAgIHJ1bihcImdpdCBpbml0IC1iIG1haW5cIiwgbWFpbkJhc2UpO1xuICAgICAgcnVuKCdnaXQgY29uZmlnIHVzZXIubmFtZSBcIlRlc3RcIicsIG1haW5CYXNlKTtcbiAgICAgIHJ1bignZ2l0IGNvbmZpZyB1c2VyLmVtYWlsIFwidGVzdEBleGFtcGxlLmNvbVwiJywgbWFpbkJhc2UpO1xuICAgICAgcnVuKCdnaXQgcmVtb3RlIGFkZCBvcmlnaW4gZ2l0QGdpdGh1Yi5jb206ZXhhbXBsZS9tYWluLXJlcG8uZ2l0JywgbWFpbkJhc2UpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKG1haW5CYXNlLCBcIlJFQURNRS5tZFwiKSwgXCIjIFRlc3RcXG5cIiwgXCJ1dGYtOFwiKTtcbiAgICAgIHJ1bihcImdpdCBhZGQgUkVBRE1FLm1kXCIsIG1haW5CYXNlKTtcbiAgICAgIHJ1bignZ2l0IGNvbW1pdCAtbSBcImluaXRcIicsIG1haW5CYXNlKTtcblxuICAgICAgLy8gQ3JlYXRlIGEgLmdzZCBkaXJlY3Rvcnkgd2l0aCBjb250ZW50XG4gICAgICBta2RpclN5bmMoam9pbihtYWluQmFzZSwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihtYWluQmFzZSwgXCIuZ3NkXCIsIFwiUFJFRkVSRU5DRVMubWRcIiksIFwiIyBwcmVmc1xcblwiLCBcInV0Zi04XCIpO1xuXG4gICAgICBjb25zdCByZXN1bHQgPSBtaWdyYXRlVG9FeHRlcm5hbFN0YXRlKG1haW5CYXNlKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQubWlncmF0ZWQsIHRydWUsIFwic2hvdWxkIG1pZ3JhdGUgb24gbWFpbiByZXBvXCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMobWFpbkJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLFVBQVUsTUFBTSxRQUFRLGFBQWE7QUFDOUMsT0FBTyxZQUFZO0FBQ25CO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxnQkFBZ0I7QUFFekIsU0FBUyw4QkFBOEI7QUFFdkMsU0FBUyxJQUFJLFNBQWlCLEtBQXFCO0FBQ2pELFNBQU8sU0FBUyxTQUFTO0FB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
