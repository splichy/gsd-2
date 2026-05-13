import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWorktreePostCreateHook } from "../auto-worktree.js";
function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "gsd-wt-hook-test-"));
}
const isWin = process.platform === "win32";
function hookPath(base) {
  return isWin ? `${base}.bat` : base;
}
function writeNodeHookScript(filePath, code) {
  if (isWin) {
    const jsPath = filePath.replace(/\.bat$/, ".js");
    writeFileSync(jsPath, code);
    writeFileSync(filePath, `@echo off
node "%~dp0${jsPath.split("\\").pop()}" %*
`);
  } else {
    writeFileSync(filePath, `#!/usr/bin/env node
${code}
`);
    chmodSync(filePath, 493);
  }
}
test("returns null when no hook path is provided", () => {
  const src = makeTmpDir();
  const wt = makeTmpDir();
  try {
    const result = runWorktreePostCreateHook(src, wt, void 0);
    assert.equal(result, null);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});
test("returns error when hook script does not exist", () => {
  const src = makeTmpDir();
  const wt = makeTmpDir();
  try {
    const result = runWorktreePostCreateHook(src, wt, ".gsd/hooks/nonexistent");
    assert.ok(result !== null, "should return error string");
    assert.ok(result.includes("not found"), "error should mention 'not found'");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});
test("executes hook script with correct SOURCE_DIR and WORKTREE_DIR env vars", () => {
  const src = makeTmpDir();
  const wt = makeTmpDir();
  try {
    const hooksDir = join(src, ".gsd", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hookFile = hookPath(join(hooksDir, "post-create"));
    const code = [
      `const fs = require("fs");`,
      `const path = require("path");`,
      `const out = path.join(process.env.WORKTREE_DIR, "hook-output.txt");`,
      `fs.writeFileSync(out, "SOURCE=" + process.env.SOURCE_DIR + "\\n" + "WORKTREE=" + process.env.WORKTREE_DIR + "\\n");`
    ].join("\n");
    writeNodeHookScript(hookFile, code);
    const result = runWorktreePostCreateHook(src, wt, hookPath(".gsd/hooks/post-create"));
    assert.equal(result, null, "should succeed");
    const outputFile = join(wt, "hook-output.txt");
    assert.ok(existsSync(outputFile), "hook should have created output file");
    const output = readFileSync(outputFile, "utf-8");
    assert.ok(output.includes(`SOURCE=${src}`), "SOURCE_DIR should match source dir");
    assert.ok(output.includes(`WORKTREE=${wt}`), "WORKTREE_DIR should match worktree dir");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});
test("returns error message when hook script fails", () => {
  const src = makeTmpDir();
  const wt = makeTmpDir();
  try {
    const hooksDir = join(src, ".gsd", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hookFile = hookPath(join(hooksDir, "failing-hook"));
    writeNodeHookScript(hookFile, `process.exit(1);`);
    const result = runWorktreePostCreateHook(src, wt, hookPath(".gsd/hooks/failing-hook"));
    assert.ok(result !== null, "should return error string");
    assert.ok(result.includes("hook failed"), "error should mention 'hook failed'");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});
test("supports absolute hook paths", () => {
  const src = makeTmpDir();
  const wt = makeTmpDir();
  try {
    const hookFile = hookPath(join(src, "absolute-hook"));
    const code = [
      `const fs = require("fs");`,
      `const path = require("path");`,
      `fs.writeFileSync(path.join(process.env.WORKTREE_DIR, "absolute-hook-ran"), "");`
    ].join("\n");
    writeNodeHookScript(hookFile, code);
    const result = runWorktreePostCreateHook(src, wt, hookFile);
    assert.equal(result, null, "absolute path hook should succeed");
    assert.ok(existsSync(join(wt, "absolute-hook-ran")), "hook should have run");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});
test("hook can copy files from source to worktree", () => {
  const src = makeTmpDir();
  const wt = makeTmpDir();
  try {
    writeFileSync(join(src, ".env"), "DB_HOST=localhost\nAPI_KEY=secret123\n");
    const hookFile = hookPath(join(src, "setup-hook"));
    const code = [
      `const fs = require("fs");`,
      `const path = require("path");`,
      `const envSrc = path.join(process.env.SOURCE_DIR, ".env");`,
      `const envDst = path.join(process.env.WORKTREE_DIR, ".env");`,
      `fs.copyFileSync(envSrc, envDst);`
    ].join("\n");
    writeNodeHookScript(hookFile, code);
    const result = runWorktreePostCreateHook(src, wt, hookFile);
    assert.equal(result, null, "hook should succeed");
    assert.ok(existsSync(join(wt, ".env")), ".env should be copied to worktree");
    const envContent = readFileSync(join(wt, ".env"), "utf-8");
    assert.ok(envContent.includes("API_KEY=secret123"), ".env content should match");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrdHJlZS1wb3N0LWNyZWF0ZS1ob29rLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogd29ya3RyZWUtcG9zdC1jcmVhdGUtaG9vay50ZXN0LnRzIFx1MjAxNCBUZXN0cyBmb3IgIzU5NyB3b3JrdHJlZSBwb3N0LWNyZWF0ZSBob29rLlxuICpcbiAqIFZlcmlmaWVzIHRoYXQgcnVuV29ya3RyZWVQb3N0Q3JlYXRlSG9vayBjb3JyZWN0bHkgZXhlY3V0ZXMgdXNlciBzY3JpcHRzXG4gKiB3aXRoIFNPVVJDRV9ESVIgYW5kIFdPUktUUkVFX0RJUiBlbnZpcm9ubWVudCB2YXJpYWJsZXMuXG4gKlxuICogVXNlcyBOb2RlLmpzIHNjcmlwdHMgaW5zdGVhZCBvZiBiYXNoIGZvciBXaW5kb3dzIGNvbXBhdGliaWxpdHkuXG4gKi9cblxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIGV4aXN0c1N5bmMsIHdyaXRlRmlsZVN5bmMsIHJlYWRGaWxlU3luYywgY2htb2RTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyBydW5Xb3JrdHJlZVBvc3RDcmVhdGVIb29rIH0gZnJvbSBcIi4uL2F1dG8td29ya3RyZWUudHNcIjtcblxuZnVuY3Rpb24gbWFrZVRtcERpcigpOiBzdHJpbmcge1xuICByZXR1cm4gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtd3QtaG9vay10ZXN0LVwiKSk7XG59XG5cbmNvbnN0IGlzV2luID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiO1xuXG4vKiogUmV0dXJuIHRoZSBwbGF0Zm9ybS1hcHByb3ByaWF0ZSBob29rIGZpbGUgcGF0aCAoYWRkcyAuYmF0IG9uIFdpbmRvd3MpLiAqL1xuZnVuY3Rpb24gaG9va1BhdGgoYmFzZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGlzV2luID8gYCR7YmFzZX0uYmF0YCA6IGJhc2U7XG59XG5cbi8qKiBDcmVhdGUgYSBjcm9zcy1wbGF0Zm9ybSBOb2RlLmpzIGhvb2sgc2NyaXB0LiAqL1xuZnVuY3Rpb24gd3JpdGVOb2RlSG9va1NjcmlwdChmaWxlUGF0aDogc3RyaW5nLCBjb2RlOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKGlzV2luKSB7XG4gICAgLy8gV3JpdGUgdGhlIEpTIGNvZGUgdG8gYSBjb21wYW5pb24gLmpzIGZpbGUgYW5kIGhhdmUgdGhlIC5iYXQgaW52b2tlIGl0LlxuICAgIC8vIG5vZGUgLWUgd2l0aCBtdWx0aS1saW5lIGNvZGUgYnJlYWtzIG9uIFdpbmRvd3MgYmVjYXVzZSBjbWQuZXhlIHNwbGl0cyBvbiBuZXdsaW5lcy5cbiAgICBjb25zdCBqc1BhdGggPSBmaWxlUGF0aC5yZXBsYWNlKC9cXC5iYXQkLywgXCIuanNcIik7XG4gICAgd3JpdGVGaWxlU3luYyhqc1BhdGgsIGNvZGUpO1xuICAgIHdyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIGBAZWNobyBvZmZcXG5ub2RlIFwiJX5kcDAke2pzUGF0aC5zcGxpdChcIlxcXFxcIikucG9wKCl9XCIgJSpcXG5gKTtcbiAgfSBlbHNlIHtcbiAgICB3cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBgIyEvdXNyL2Jpbi9lbnYgbm9kZVxcbiR7Y29kZX1cXG5gKTtcbiAgICBjaG1vZFN5bmMoZmlsZVBhdGgsIDBvNzU1KTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgcnVuV29ya3RyZWVQb3N0Q3JlYXRlSG9vayBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInJldHVybnMgbnVsbCB3aGVuIG5vIGhvb2sgcGF0aCBpcyBwcm92aWRlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IHNyYyA9IG1ha2VUbXBEaXIoKTtcbiAgY29uc3Qgd3QgPSBtYWtlVG1wRGlyKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gcnVuV29ya3RyZWVQb3N0Q3JlYXRlSG9vayhzcmMsIHd0LCB1bmRlZmluZWQpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIG51bGwpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhzcmMsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICBybVN5bmMod3QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJyZXR1cm5zIGVycm9yIHdoZW4gaG9vayBzY3JpcHQgZG9lcyBub3QgZXhpc3RcIiwgKCkgPT4ge1xuICBjb25zdCBzcmMgPSBtYWtlVG1wRGlyKCk7XG4gIGNvbnN0IHd0ID0gbWFrZVRtcERpcigpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IHJ1bldvcmt0cmVlUG9zdENyZWF0ZUhvb2soc3JjLCB3dCwgXCIuZ3NkL2hvb2tzL25vbmV4aXN0ZW50XCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQgIT09IG51bGwsIFwic2hvdWxkIHJldHVybiBlcnJvciBzdHJpbmdcIik7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdCEuaW5jbHVkZXMoXCJub3QgZm91bmRcIiksIFwiZXJyb3Igc2hvdWxkIG1lbnRpb24gJ25vdCBmb3VuZCdcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHNyYywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIHJtU3luYyh3dCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcImV4ZWN1dGVzIGhvb2sgc2NyaXB0IHdpdGggY29ycmVjdCBTT1VSQ0VfRElSIGFuZCBXT1JLVFJFRV9ESVIgZW52IHZhcnNcIiwgKCkgPT4ge1xuICBjb25zdCBzcmMgPSBtYWtlVG1wRGlyKCk7XG4gIGNvbnN0IHd0ID0gbWFrZVRtcERpcigpO1xuICB0cnkge1xuICAgIGNvbnN0IGhvb2tzRGlyID0gam9pbihzcmMsIFwiLmdzZFwiLCBcImhvb2tzXCIpO1xuICAgIG1rZGlyU3luYyhob29rc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgY29uc3QgaG9va0ZpbGUgPSBob29rUGF0aChqb2luKGhvb2tzRGlyLCBcInBvc3QtY3JlYXRlXCIpKTtcbiAgICBjb25zdCBjb2RlID0gW1xuICAgICAgYGNvbnN0IGZzID0gcmVxdWlyZShcImZzXCIpO2AsXG4gICAgICBgY29uc3QgcGF0aCA9IHJlcXVpcmUoXCJwYXRoXCIpO2AsXG4gICAgICBgY29uc3Qgb3V0ID0gcGF0aC5qb2luKHByb2Nlc3MuZW52LldPUktUUkVFX0RJUiwgXCJob29rLW91dHB1dC50eHRcIik7YCxcbiAgICAgIGBmcy53cml0ZUZpbGVTeW5jKG91dCwgXCJTT1VSQ0U9XCIgKyBwcm9jZXNzLmVudi5TT1VSQ0VfRElSICsgXCJcXFxcblwiICsgXCJXT1JLVFJFRT1cIiArIHByb2Nlc3MuZW52LldPUktUUkVFX0RJUiArIFwiXFxcXG5cIik7YCxcbiAgICBdLmpvaW4oXCJcXG5cIik7XG4gICAgd3JpdGVOb2RlSG9va1NjcmlwdChob29rRmlsZSwgY29kZSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBydW5Xb3JrdHJlZVBvc3RDcmVhdGVIb29rKHNyYywgd3QsIGhvb2tQYXRoKFwiLmdzZC9ob29rcy9wb3N0LWNyZWF0ZVwiKSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgbnVsbCwgXCJzaG91bGQgc3VjY2VlZFwiKTtcblxuICAgIGNvbnN0IG91dHB1dEZpbGUgPSBqb2luKHd0LCBcImhvb2stb3V0cHV0LnR4dFwiKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhvdXRwdXRGaWxlKSwgXCJob29rIHNob3VsZCBoYXZlIGNyZWF0ZWQgb3V0cHV0IGZpbGVcIik7XG5cbiAgICBjb25zdCBvdXRwdXQgPSByZWFkRmlsZVN5bmMob3V0cHV0RmlsZSwgXCJ1dGYtOFwiKTtcbiAgICBhc3NlcnQub2sob3V0cHV0LmluY2x1ZGVzKGBTT1VSQ0U9JHtzcmN9YCksIFwiU09VUkNFX0RJUiBzaG91bGQgbWF0Y2ggc291cmNlIGRpclwiKTtcbiAgICBhc3NlcnQub2sob3V0cHV0LmluY2x1ZGVzKGBXT1JLVFJFRT0ke3d0fWApLCBcIldPUktUUkVFX0RJUiBzaG91bGQgbWF0Y2ggd29ya3RyZWUgZGlyXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhzcmMsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICBybVN5bmMod3QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJyZXR1cm5zIGVycm9yIG1lc3NhZ2Ugd2hlbiBob29rIHNjcmlwdCBmYWlsc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHNyYyA9IG1ha2VUbXBEaXIoKTtcbiAgY29uc3Qgd3QgPSBtYWtlVG1wRGlyKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgaG9va3NEaXIgPSBqb2luKHNyYywgXCIuZ3NkXCIsIFwiaG9va3NcIik7XG4gICAgbWtkaXJTeW5jKGhvb2tzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBjb25zdCBob29rRmlsZSA9IGhvb2tQYXRoKGpvaW4oaG9va3NEaXIsIFwiZmFpbGluZy1ob29rXCIpKTtcbiAgICB3cml0ZU5vZGVIb29rU2NyaXB0KGhvb2tGaWxlLCBgcHJvY2Vzcy5leGl0KDEpO2ApO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gcnVuV29ya3RyZWVQb3N0Q3JlYXRlSG9vayhzcmMsIHd0LCBob29rUGF0aChcIi5nc2QvaG9va3MvZmFpbGluZy1ob29rXCIpKTtcbiAgICBhc3NlcnQub2socmVzdWx0ICE9PSBudWxsLCBcInNob3VsZCByZXR1cm4gZXJyb3Igc3RyaW5nXCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQhLmluY2x1ZGVzKFwiaG9vayBmYWlsZWRcIiksIFwiZXJyb3Igc2hvdWxkIG1lbnRpb24gJ2hvb2sgZmFpbGVkJ1wiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMoc3JjLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgcm1TeW5jKHd0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwic3VwcG9ydHMgYWJzb2x1dGUgaG9vayBwYXRoc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHNyYyA9IG1ha2VUbXBEaXIoKTtcbiAgY29uc3Qgd3QgPSBtYWtlVG1wRGlyKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgaG9va0ZpbGUgPSBob29rUGF0aChqb2luKHNyYywgXCJhYnNvbHV0ZS1ob29rXCIpKTtcbiAgICBjb25zdCBjb2RlID0gW1xuICAgICAgYGNvbnN0IGZzID0gcmVxdWlyZShcImZzXCIpO2AsXG4gICAgICBgY29uc3QgcGF0aCA9IHJlcXVpcmUoXCJwYXRoXCIpO2AsXG4gICAgICBgZnMud3JpdGVGaWxlU3luYyhwYXRoLmpvaW4ocHJvY2Vzcy5lbnYuV09SS1RSRUVfRElSLCBcImFic29sdXRlLWhvb2stcmFuXCIpLCBcIlwiKTtgLFxuICAgIF0uam9pbihcIlxcblwiKTtcbiAgICB3cml0ZU5vZGVIb29rU2NyaXB0KGhvb2tGaWxlLCBjb2RlKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHJ1bldvcmt0cmVlUG9zdENyZWF0ZUhvb2soc3JjLCB3dCwgaG9va0ZpbGUpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIG51bGwsIFwiYWJzb2x1dGUgcGF0aCBob29rIHNob3VsZCBzdWNjZWVkXCIpO1xuICAgIGFzc2VydC5vayhleGlzdHNTeW5jKGpvaW4od3QsIFwiYWJzb2x1dGUtaG9vay1yYW5cIikpLCBcImhvb2sgc2hvdWxkIGhhdmUgcnVuXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhzcmMsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICBybVN5bmMod3QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJob29rIGNhbiBjb3B5IGZpbGVzIGZyb20gc291cmNlIHRvIHdvcmt0cmVlXCIsICgpID0+IHtcbiAgY29uc3Qgc3JjID0gbWFrZVRtcERpcigpO1xuICBjb25zdCB3dCA9IG1ha2VUbXBEaXIoKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oc3JjLCBcIi5lbnZcIiksIFwiREJfSE9TVD1sb2NhbGhvc3RcXG5BUElfS0VZPXNlY3JldDEyM1xcblwiKTtcblxuICAgIGNvbnN0IGhvb2tGaWxlID0gaG9va1BhdGgoam9pbihzcmMsIFwic2V0dXAtaG9va1wiKSk7XG4gICAgY29uc3QgY29kZSA9IFtcbiAgICAgIGBjb25zdCBmcyA9IHJlcXVpcmUoXCJmc1wiKTtgLFxuICAgICAgYGNvbnN0IHBhdGggPSByZXF1aXJlKFwicGF0aFwiKTtgLFxuICAgICAgYGNvbnN0IGVudlNyYyA9IHBhdGguam9pbihwcm9jZXNzLmVudi5TT1VSQ0VfRElSLCBcIi5lbnZcIik7YCxcbiAgICAgIGBjb25zdCBlbnZEc3QgPSBwYXRoLmpvaW4ocHJvY2Vzcy5lbnYuV09SS1RSRUVfRElSLCBcIi5lbnZcIik7YCxcbiAgICAgIGBmcy5jb3B5RmlsZVN5bmMoZW52U3JjLCBlbnZEc3QpO2AsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuICAgIHdyaXRlTm9kZUhvb2tTY3JpcHQoaG9va0ZpbGUsIGNvZGUpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gcnVuV29ya3RyZWVQb3N0Q3JlYXRlSG9vayhzcmMsIHd0LCBob29rRmlsZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgbnVsbCwgXCJob29rIHNob3VsZCBzdWNjZWVkXCIpO1xuXG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoam9pbih3dCwgXCIuZW52XCIpKSwgXCIuZW52IHNob3VsZCBiZSBjb3BpZWQgdG8gd29ya3RyZWVcIik7XG4gICAgY29uc3QgZW52Q29udGVudCA9IHJlYWRGaWxlU3luYyhqb2luKHd0LCBcIi5lbnZcIiksIFwidXRmLThcIik7XG4gICAgYXNzZXJ0Lm9rKGVudkNvbnRlbnQuaW5jbHVkZXMoXCJBUElfS0VZPXNlY3JldDEyM1wiKSwgXCIuZW52IGNvbnRlbnQgc2hvdWxkIG1hdGNoXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhzcmMsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICBybVN5bmMod3QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFTQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEsWUFBWSxlQUFlLGNBQWMsaUJBQWlCO0FBQ25HLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUyxpQ0FBaUM7QUFFMUMsU0FBUyxhQUFxQjtBQUM1QixTQUFPLFlBQVksS0FBSyxPQUFPLEdBQUcsbUJBQW1CLENBQUM7QUFDeEQ7QUFFQSxNQUFNLFFBQVEsUUFBUSxhQUFhO0FBR25DLFNBQVMsU0FBUyxNQUFzQjtBQUN0QyxTQUFPLFFBQVEsR0FBRyxJQUFJLFNBQVM7QUFDakM7QUFHQSxTQUFTLG9CQUFvQixVQUFrQixNQUFvQjtBQUNqRSxNQUFJLE9BQU87QUFHVCxVQUFNLFNBQVMsU0FBUyxRQUFRLFVBQVUsS0FBSztBQUMvQyxrQkFBYyxRQUFRLElBQUk7QUFDMUIsa0JBQWMsVUFBVTtBQUFBLGFBQXlCLE9BQU8sTUFBTSxJQUFJLEVBQUUsSUFBSSxDQUFDO0FBQUEsQ0FBUTtBQUFBLEVBQ25GLE9BQU87QUFDTCxrQkFBYyxVQUFVO0FBQUEsRUFBd0IsSUFBSTtBQUFBLENBQUk7QUFDeEQsY0FBVSxVQUFVLEdBQUs7QUFBQSxFQUMzQjtBQUNGO0FBSUEsS0FBSyw4Q0FBOEMsTUFBTTtBQUN2RCxRQUFNLE1BQU0sV0FBVztBQUN2QixRQUFNLEtBQUssV0FBVztBQUN0QixNQUFJO0FBQ0YsVUFBTSxTQUFTLDBCQUEwQixLQUFLLElBQUksTUFBUztBQUMzRCxXQUFPLE1BQU0sUUFBUSxJQUFJO0FBQUEsRUFDM0IsVUFBRTtBQUNBLFdBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUM1QyxXQUFPLElBQUksRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUM3QztBQUNGLENBQUM7QUFFRCxLQUFLLGlEQUFpRCxNQUFNO0FBQzFELFFBQU0sTUFBTSxXQUFXO0FBQ3ZCLFFBQU0sS0FBSyxXQUFXO0FBQ3RCLE1BQUk7QUFDRixVQUFNLFNBQVMsMEJBQTBCLEtBQUssSUFBSSx3QkFBd0I7QUFDMUUsV0FBTyxHQUFHLFdBQVcsTUFBTSw0QkFBNEI7QUFDdkQsV0FBTyxHQUFHLE9BQVEsU0FBUyxXQUFXLEdBQUcsa0NBQWtDO0FBQUEsRUFDN0UsVUFBRTtBQUNBLFdBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUM1QyxXQUFPLElBQUksRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUM3QztBQUNGLENBQUM7QUFFRCxLQUFLLDBFQUEwRSxNQUFNO0FBQ25GLFFBQU0sTUFBTSxXQUFXO0FBQ3ZCLFFBQU0sS0FBSyxXQUFXO0FBQ3RCLE1BQUk7QUFDRixVQUFNLFdBQVcsS0FBSyxLQUFLLFFBQVEsT0FBTztBQUMxQyxjQUFVLFVBQVUsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN2QyxVQUFNLFdBQVcsU0FBUyxLQUFLLFVBQVUsYUFBYSxDQUFDO0FBQ3ZELFVBQU0sT0FBTztBQUFBLE1BQ1g7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGLEVBQUUsS0FBSyxJQUFJO0FBQ1gsd0JBQW9CLFVBQVUsSUFBSTtBQUVsQyxVQUFNLFNBQVMsMEJBQTBCLEtBQUssSUFBSSxTQUFTLHdCQUF3QixDQUFDO0FBQ3BGLFdBQU8sTUFBTSxRQUFRLE1BQU0sZ0JBQWdCO0FBRTNDLFVBQU0sYUFBYSxLQUFLLElBQUksaUJBQWlCO0FBQzdDLFdBQU8sR0FBRyxXQUFXLFVBQVUsR0FBRyxzQ0FBc0M7QUFFeEUsVUFBTSxTQUFTLGFBQWEsWUFBWSxPQUFPO0FBQy9DLFdBQU8sR0FBRyxPQUFPLFNBQVMsVUFBVSxHQUFHLEVBQUUsR0FBRyxvQ0FBb0M7QUFDaEYsV0FBTyxHQUFHLE9BQU8sU0FBUyxZQUFZLEVBQUUsRUFBRSxHQUFHLHdDQUF3QztBQUFBLEVBQ3ZGLFVBQUU7QUFDQSxXQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFDNUMsV0FBTyxJQUFJLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDN0M7QUFDRixDQUFDO0FBRUQsS0FBSyxnREFBZ0QsTUFBTTtBQUN6RCxRQUFNLE1BQU0sV0FBVztBQUN2QixRQUFNLEtBQUssV0FBVztBQUN0QixNQUFJO0FBQ0YsVUFBTSxXQUFXLEtBQUssS0FBSyxRQUFRLE9BQU87QUFDMUMsY0FBVSxVQUFVLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdkMsVUFBTSxXQUFXLFNBQVMsS0FBSyxVQUFVLGNBQWMsQ0FBQztBQUN4RCx3QkFBb0IsVUFBVSxrQkFBa0I7QUFFaEQsVUFBTSxTQUFTLDBCQUEwQixLQUFLLElBQUksU0FBUyx5QkFBeUIsQ0FBQztBQUNyRixXQUFPLEdBQUcsV0FBVyxNQUFNLDRCQUE0QjtBQUN2RCxXQUFPLEdBQUcsT0FBUSxTQUFTLGFBQWEsR0FBRyxvQ0FBb0M7QUFBQSxFQUNqRixVQUFFO0FBQ0EsV0FBTyxLQUFLLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQzVDLFdBQU8sSUFBSSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQzdDO0FBQ0YsQ0FBQztBQUVELEtBQUssZ0NBQWdDLE1BQU07QUFDekMsUUFBTSxNQUFNLFdBQVc7QUFDdkIsUUFBTSxLQUFLLFdBQVc7QUFDdEIsTUFBSTtBQUNGLFVBQU0sV0FBVyxTQUFTLEtBQUssS0FBSyxlQUFlLENBQUM7QUFDcEQsVUFBTSxPQUFPO0FBQUEsTUFDWDtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRixFQUFFLEtBQUssSUFBSTtBQUNYLHdCQUFvQixVQUFVLElBQUk7QUFFbEMsVUFBTSxTQUFTLDBCQUEwQixLQUFLLElBQUksUUFBUTtBQUMxRCxXQUFPLE1BQU0sUUFBUSxNQUFNLG1DQUFtQztBQUM5RCxXQUFPLEdBQUcsV0FBVyxLQUFLLElBQUksbUJBQW1CLENBQUMsR0FBRyxzQkFBc0I7QUFBQSxFQUM3RSxVQUFFO0FBQ0EsV0FBTyxLQUFLLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQzVDLFdBQU8sSUFBSSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQzdDO0FBQ0YsQ0FBQztBQUVELEtBQUssK0NBQStDLE1BQU07QUFDeEQsUUFBTSxNQUFNLFdBQVc7QUFDdkIsUUFBTSxLQUFLLFdBQVc7QUFDdEIsTUFBSTtBQUNGLGtCQUFjLEtBQUssS0FBSyxNQUFNLEdBQUcsd0NBQXdDO0FBRXpFLFVBQU0sV0FBVyxTQUFTLEtBQUssS0FBSyxZQUFZLENBQUM7QUFDakQsVUFBTSxPQUFPO0FBQUEsTUFDWDtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGLEVBQUUsS0FBSyxJQUFJO0FBQ1gsd0JBQW9CLFVBQVUsSUFBSTtBQUVsQyxVQUFNLFNBQVMsMEJBQTBCLEtBQUssSUFBSSxRQUFRO0FBQzFELFdBQU8sTUFBTSxRQUFRLE1BQU0scUJBQXFCO0FBRWhELFdBQU8sR0FBRyxXQUFXLEtBQUssSUFBSSxNQUFNLENBQUMsR0FBRyxtQ0FBbUM7QUFDM0UsVUFBTSxhQUFhLGFBQWEsS0FBSyxJQUFJLE1BQU0sR0FBRyxPQUFPO0FBQ3pELFdBQU8sR0FBRyxXQUFXLFNBQVMsbUJBQW1CLEdBQUcsMkJBQTJCO0FBQUEsRUFDakYsVUFBRTtBQUNBLFdBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUM1QyxXQUFPLElBQUksRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUM3QztBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
