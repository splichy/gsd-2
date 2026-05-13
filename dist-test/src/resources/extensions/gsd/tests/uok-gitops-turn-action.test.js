import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { handleTurnGitActionError, runTurnGitAction } from "../git-service.js";
function run(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: "pipe", encoding: "utf-8" }).trim();
}
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "gsd-uok-gitops-"));
  run("git init", repo);
  run('git config user.email "test@example.com"', repo);
  run('git config user.name "Test User"', repo);
  writeFileSync(join(repo, "README.md"), "# Test\n", "utf-8");
  run("git add README.md", repo);
  run('git commit -m "chore: init"', repo);
  return repo;
}
test("uok gitops turn action status-only reports working tree dirtiness", () => {
  const repo = makeRepo();
  try {
    const clean = runTurnGitAction({
      basePath: repo,
      action: "status-only",
      unitType: "execute-task",
      unitId: "M001/S01/T01"
    });
    assert.equal(clean.status, "ok");
    assert.equal(clean.dirty, false);
    writeFileSync(join(repo, "README.md"), "# Dirty\n", "utf-8");
    const dirty = runTurnGitAction({
      basePath: repo,
      action: "status-only",
      unitType: "execute-task",
      unitId: "M001/S01/T01"
    });
    assert.equal(dirty.status, "ok");
    assert.equal(dirty.dirty, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
test("uok gitops turn action snapshot writes snapshot refs", () => {
  const repo = makeRepo();
  try {
    const result = runTurnGitAction({
      basePath: repo,
      action: "snapshot",
      unitType: "execute-task",
      unitId: "M001/S01/T01"
    });
    assert.equal(result.status, "ok");
    assert.ok(result.snapshotLabel?.includes("execute-task/M001/S01/T01"));
    const refs = run("git for-each-ref refs/gsd/snapshots/ --format='%(refname)'", repo);
    assert.ok(refs.includes("refs/gsd/snapshots/execute-task/M001/S01/T01/"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
test("uok gitops turn action commit creates commit with unit trailer", () => {
  const repo = makeRepo();
  try {
    writeFileSync(join(repo, "feature.ts"), "export const x = 1;\n", "utf-8");
    const result = runTurnGitAction({
      basePath: repo,
      action: "commit",
      unitType: "execute-task",
      unitId: "M001/S01/T02"
    });
    assert.equal(result.status, "ok");
    assert.ok(result.commitMessage?.includes("chore: auto-commit after execute-task"));
    const body = run("git log -1 --pretty=%B", repo);
    assert.ok(body.includes("GSD-Unit: M001/S01/T02"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
test("uok gitops turn action rethrows infrastructure failures", () => {
  const err = Object.assign(new Error("ENFILE: file table overflow"), { code: "ENFILE" });
  assert.throws(() => handleTurnGitActionError("commit", err), (thrown) => thrown === err);
});
test("uok gitops turn action keeps non-infrastructure git failures recoverable", () => {
  const result = handleTurnGitActionError("commit", new Error("nothing to commit"));
  assert.equal(result.action, "commit");
  assert.equal(result.status, "failed");
  assert.equal(result.error, "nothing to commit");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy91b2stZ2l0b3BzLXR1cm4tYWN0aW9uLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGV4ZWNTeW5jIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgaGFuZGxlVHVybkdpdEFjdGlvbkVycm9yLCBydW5UdXJuR2l0QWN0aW9uIH0gZnJvbSBcIi4uL2dpdC1zZXJ2aWNlLnRzXCI7XG5cbmZ1bmN0aW9uIHJ1bihjbWQ6IHN0cmluZywgY3dkOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gZXhlY1N5bmMoY21kLCB7IGN3ZCwgc3RkaW86IFwicGlwZVwiLCBlbmNvZGluZzogXCJ1dGYtOFwiIH0pLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gbWFrZVJlcG8oKTogc3RyaW5nIHtcbiAgY29uc3QgcmVwbyA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXVvay1naXRvcHMtXCIpKTtcbiAgcnVuKFwiZ2l0IGluaXRcIiwgcmVwbyk7XG4gIHJ1bignZ2l0IGNvbmZpZyB1c2VyLmVtYWlsIFwidGVzdEBleGFtcGxlLmNvbVwiJywgcmVwbyk7XG4gIHJ1bignZ2l0IGNvbmZpZyB1c2VyLm5hbWUgXCJUZXN0IFVzZXJcIicsIHJlcG8pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4ocmVwbywgXCJSRUFETUUubWRcIiksIFwiIyBUZXN0XFxuXCIsIFwidXRmLThcIik7XG4gIHJ1bihcImdpdCBhZGQgUkVBRE1FLm1kXCIsIHJlcG8pO1xuICBydW4oJ2dpdCBjb21taXQgLW0gXCJjaG9yZTogaW5pdFwiJywgcmVwbyk7XG4gIHJldHVybiByZXBvO1xufVxuXG50ZXN0KFwidW9rIGdpdG9wcyB0dXJuIGFjdGlvbiBzdGF0dXMtb25seSByZXBvcnRzIHdvcmtpbmcgdHJlZSBkaXJ0aW5lc3NcIiwgKCkgPT4ge1xuICBjb25zdCByZXBvID0gbWFrZVJlcG8oKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBjbGVhbiA9IHJ1blR1cm5HaXRBY3Rpb24oe1xuICAgICAgYmFzZVBhdGg6IHJlcG8sXG4gICAgICBhY3Rpb246IFwic3RhdHVzLW9ubHlcIixcbiAgICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgIH0pO1xuICAgIGFzc2VydC5lcXVhbChjbGVhbi5zdGF0dXMsIFwib2tcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGNsZWFuLmRpcnR5LCBmYWxzZSk7XG5cbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocmVwbywgXCJSRUFETUUubWRcIiksIFwiIyBEaXJ0eVxcblwiLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IGRpcnR5ID0gcnVuVHVybkdpdEFjdGlvbih7XG4gICAgICBiYXNlUGF0aDogcmVwbyxcbiAgICAgIGFjdGlvbjogXCJzdGF0dXMtb25seVwiLFxuICAgICAgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgICB1bml0SWQ6IFwiTTAwMS9TMDEvVDAxXCIsXG4gICAgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKGRpcnR5LnN0YXR1cywgXCJva1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoZGlydHkuZGlydHksIHRydWUpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhyZXBvLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwidW9rIGdpdG9wcyB0dXJuIGFjdGlvbiBzbmFwc2hvdCB3cml0ZXMgc25hcHNob3QgcmVmc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlcG8gPSBtYWtlUmVwbygpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IHJ1blR1cm5HaXRBY3Rpb24oe1xuICAgICAgYmFzZVBhdGg6IHJlcG8sXG4gICAgICBhY3Rpb246IFwic25hcHNob3RcIixcbiAgICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgIH0pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdHVzLCBcIm9rXCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuc25hcHNob3RMYWJlbD8uaW5jbHVkZXMoXCJleGVjdXRlLXRhc2svTTAwMS9TMDEvVDAxXCIpKTtcbiAgICBjb25zdCByZWZzID0gcnVuKFwiZ2l0IGZvci1lYWNoLXJlZiByZWZzL2dzZC9zbmFwc2hvdHMvIC0tZm9ybWF0PSclKHJlZm5hbWUpJ1wiLCByZXBvKTtcbiAgICBhc3NlcnQub2socmVmcy5pbmNsdWRlcyhcInJlZnMvZ3NkL3NuYXBzaG90cy9leGVjdXRlLXRhc2svTTAwMS9TMDEvVDAxL1wiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHJlcG8sIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJ1b2sgZ2l0b3BzIHR1cm4gYWN0aW9uIGNvbW1pdCBjcmVhdGVzIGNvbW1pdCB3aXRoIHVuaXQgdHJhaWxlclwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlcG8gPSBtYWtlUmVwbygpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXBvLCBcImZlYXR1cmUudHNcIiksIFwiZXhwb3J0IGNvbnN0IHggPSAxO1xcblwiLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHJlc3VsdCA9IHJ1blR1cm5HaXRBY3Rpb24oe1xuICAgICAgYmFzZVBhdGg6IHJlcG8sXG4gICAgICBhY3Rpb246IFwiY29tbWl0XCIsXG4gICAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDJcIixcbiAgICB9KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXR1cywgXCJva1wiKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmNvbW1pdE1lc3NhZ2U/LmluY2x1ZGVzKFwiY2hvcmU6IGF1dG8tY29tbWl0IGFmdGVyIGV4ZWN1dGUtdGFza1wiKSk7XG4gICAgY29uc3QgYm9keSA9IHJ1bihcImdpdCBsb2cgLTEgLS1wcmV0dHk9JUJcIiwgcmVwbyk7XG4gICAgYXNzZXJ0Lm9rKGJvZHkuaW5jbHVkZXMoXCJHU0QtVW5pdDogTTAwMS9TMDEvVDAyXCIpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMocmVwbywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcInVvayBnaXRvcHMgdHVybiBhY3Rpb24gcmV0aHJvd3MgaW5mcmFzdHJ1Y3R1cmUgZmFpbHVyZXNcIiwgKCkgPT4ge1xuICBjb25zdCBlcnIgPSBPYmplY3QuYXNzaWduKG5ldyBFcnJvcihcIkVORklMRTogZmlsZSB0YWJsZSBvdmVyZmxvd1wiKSwgeyBjb2RlOiBcIkVORklMRVwiIH0pO1xuXG4gIGFzc2VydC50aHJvd3MoKCkgPT4gaGFuZGxlVHVybkdpdEFjdGlvbkVycm9yKFwiY29tbWl0XCIsIGVyciksICh0aHJvd24pID0+IHRocm93biA9PT0gZXJyKTtcbn0pO1xuXG50ZXN0KFwidW9rIGdpdG9wcyB0dXJuIGFjdGlvbiBrZWVwcyBub24taW5mcmFzdHJ1Y3R1cmUgZ2l0IGZhaWx1cmVzIHJlY292ZXJhYmxlXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gaGFuZGxlVHVybkdpdEFjdGlvbkVycm9yKFwiY29tbWl0XCIsIG5ldyBFcnJvcihcIm5vdGhpbmcgdG8gY29tbWl0XCIpKTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0LmFjdGlvbiwgXCJjb21taXRcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdHVzLCBcImZhaWxlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5lcnJvciwgXCJub3RoaW5nIHRvIGNvbW1pdFwiKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsUUFBUSxxQkFBcUI7QUFDbkQsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsWUFBWTtBQUNyQixTQUFTLGdCQUFnQjtBQUN6QixTQUFTLDBCQUEwQix3QkFBd0I7QUFFM0QsU0FBUyxJQUFJLEtBQWEsS0FBcUI7QUFDN0MsU0FBTyxTQUFTLEtBQUssRUFBRSxLQUFLLE9BQU8sUUFBUSxVQUFVLFFBQVEsQ0FBQyxFQUFFLEtBQUs7QUFDdkU7QUFFQSxTQUFTLFdBQW1CO0FBQzFCLFFBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLGlCQUFpQixDQUFDO0FBQzFELE1BQUksWUFBWSxJQUFJO0FBQ3BCLE1BQUksNENBQTRDLElBQUk7QUFDcEQsTUFBSSxvQ0FBb0MsSUFBSTtBQUM1QyxnQkFBYyxLQUFLLE1BQU0sV0FBVyxHQUFHLFlBQVksT0FBTztBQUMxRCxNQUFJLHFCQUFxQixJQUFJO0FBQzdCLE1BQUksK0JBQStCLElBQUk7QUFDdkMsU0FBTztBQUNUO0FBRUEsS0FBSyxxRUFBcUUsTUFBTTtBQUM5RSxRQUFNLE9BQU8sU0FBUztBQUN0QixNQUFJO0FBQ0YsVUFBTSxRQUFRLGlCQUFpQjtBQUFBLE1BQzdCLFVBQVU7QUFBQSxNQUNWLFFBQVE7QUFBQSxNQUNSLFVBQVU7QUFBQSxNQUNWLFFBQVE7QUFBQSxJQUNWLENBQUM7QUFDRCxXQUFPLE1BQU0sTUFBTSxRQUFRLElBQUk7QUFDL0IsV0FBTyxNQUFNLE1BQU0sT0FBTyxLQUFLO0FBRS9CLGtCQUFjLEtBQUssTUFBTSxXQUFXLEdBQUcsYUFBYSxPQUFPO0FBQzNELFVBQU0sUUFBUSxpQkFBaUI7QUFBQSxNQUM3QixVQUFVO0FBQUEsTUFDVixRQUFRO0FBQUEsTUFDUixVQUFVO0FBQUEsTUFDVixRQUFRO0FBQUEsSUFDVixDQUFDO0FBQ0QsV0FBTyxNQUFNLE1BQU0sUUFBUSxJQUFJO0FBQy9CLFdBQU8sTUFBTSxNQUFNLE9BQU8sSUFBSTtBQUFBLEVBQ2hDLFVBQUU7QUFDQSxXQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUMvQztBQUNGLENBQUM7QUFFRCxLQUFLLHdEQUF3RCxNQUFNO0FBQ2pFLFFBQU0sT0FBTyxTQUFTO0FBQ3RCLE1BQUk7QUFDRixVQUFNLFNBQVMsaUJBQWlCO0FBQUEsTUFDOUIsVUFBVTtBQUFBLE1BQ1YsUUFBUTtBQUFBLE1BQ1IsVUFBVTtBQUFBLE1BQ1YsUUFBUTtBQUFBLElBQ1YsQ0FBQztBQUNELFdBQU8sTUFBTSxPQUFPLFFBQVEsSUFBSTtBQUNoQyxXQUFPLEdBQUcsT0FBTyxlQUFlLFNBQVMsMkJBQTJCLENBQUM7QUFDckUsVUFBTSxPQUFPLElBQUksOERBQThELElBQUk7QUFDbkYsV0FBTyxHQUFHLEtBQUssU0FBUywrQ0FBK0MsQ0FBQztBQUFBLEVBQzFFLFVBQUU7QUFDQSxXQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUMvQztBQUNGLENBQUM7QUFFRCxLQUFLLGtFQUFrRSxNQUFNO0FBQzNFLFFBQU0sT0FBTyxTQUFTO0FBQ3RCLE1BQUk7QUFDRixrQkFBYyxLQUFLLE1BQU0sWUFBWSxHQUFHLHlCQUF5QixPQUFPO0FBQ3hFLFVBQU0sU0FBUyxpQkFBaUI7QUFBQSxNQUM5QixVQUFVO0FBQUEsTUFDVixRQUFRO0FBQUEsTUFDUixVQUFVO0FBQUEsTUFDVixRQUFRO0FBQUEsSUFDVixDQUFDO0FBQ0QsV0FBTyxNQUFNLE9BQU8sUUFBUSxJQUFJO0FBQ2hDLFdBQU8sR0FBRyxPQUFPLGVBQWUsU0FBUyx1Q0FBdUMsQ0FBQztBQUNqRixVQUFNLE9BQU8sSUFBSSwwQkFBMEIsSUFBSTtBQUMvQyxXQUFPLEdBQUcsS0FBSyxTQUFTLHdCQUF3QixDQUFDO0FBQUEsRUFDbkQsVUFBRTtBQUNBLFdBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQy9DO0FBQ0YsQ0FBQztBQUVELEtBQUssMkRBQTJELE1BQU07QUFDcEUsUUFBTSxNQUFNLE9BQU8sT0FBTyxJQUFJLE1BQU0sNkJBQTZCLEdBQUcsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUV0RixTQUFPLE9BQU8sTUFBTSx5QkFBeUIsVUFBVSxHQUFHLEdBQUcsQ0FBQyxXQUFXLFdBQVcsR0FBRztBQUN6RixDQUFDO0FBRUQsS0FBSyw0RUFBNEUsTUFBTTtBQUNyRixRQUFNLFNBQVMseUJBQXlCLFVBQVUsSUFBSSxNQUFNLG1CQUFtQixDQUFDO0FBRWhGLFNBQU8sTUFBTSxPQUFPLFFBQVEsUUFBUTtBQUNwQyxTQUFPLE1BQU0sT0FBTyxRQUFRLFFBQVE7QUFDcEMsU0FBTyxNQUFNLE9BQU8sT0FBTyxtQkFBbUI7QUFDaEQsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
