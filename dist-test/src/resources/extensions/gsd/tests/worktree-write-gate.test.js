import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldBlockWorktreeWrite } from "../bootstrap/write-gate.js";
import { invalidateAllCaches } from "../cache.js";
function makeProject(isolation) {
  const root = mkdtempSync(join(tmpdir(), "wt-write-gate-"));
  if (isolation !== null) {
    mkdirSync(join(root, ".gsd"), { recursive: true });
    writeFileSync(
      join(root, ".gsd", "PREFERENCES.md"),
      `---
git:
  isolation: "${isolation}"
---
`
    );
  }
  invalidateAllCaches();
  return root;
}
const PLANNING_WRITE_TOOLS = ["write", "edit", "multi_edit", "notebook_edit"];
describe("shouldBlockWorktreeWrite (#5199)", () => {
  let projectRoot;
  let prevDisableEnv;
  beforeEach(() => {
    prevDisableEnv = process.env.GSD_DISABLE_WORKTREE_WRITE_GUARD;
    delete process.env.GSD_DISABLE_WORKTREE_WRITE_GUARD;
  });
  afterEach(() => {
    if (projectRoot) {
      try {
        rmSync(projectRoot, { recursive: true, force: true });
      } catch {
      }
    }
    if (prevDisableEnv === void 0) {
      delete process.env.GSD_DISABLE_WORKTREE_WRITE_GUARD;
    } else {
      process.env.GSD_DISABLE_WORKTREE_WRITE_GUARD = prevDisableEnv;
    }
    invalidateAllCaches();
  });
  test("Case 1: every PLANNING_WRITE_TOOLS variant writing to <root>/app.js is blocked", () => {
    projectRoot = makeProject("worktree");
    for (const tool of PLANNING_WRITE_TOOLS) {
      const result = shouldBlockWorktreeWrite(
        tool,
        join(projectRoot, "app.js"),
        projectRoot,
        /* isAutoLive */
        false,
        /* unitType */
        null
      );
      assert.equal(result.block, true, `tool ${tool} should be blocked`);
      assert.match(result.reason ?? "", /HARD BLOCK/);
    }
  });
  test("Case 2: write to <root>/.gsd/PROJECT.md is allowed", () => {
    projectRoot = makeProject("worktree");
    const result = shouldBlockWorktreeWrite(
      "write",
      join(projectRoot, ".gsd", "PROJECT.md"),
      projectRoot,
      false,
      null
    );
    assert.equal(result.block, false);
  });
  test("Case 3: write inside <root>/.gsd/worktrees/M001/ is allowed", () => {
    projectRoot = makeProject("worktree");
    const target = join(projectRoot, ".gsd", "worktrees", "M001", "src", "app.js");
    const result = shouldBlockWorktreeWrite("edit", target, projectRoot, false, null);
    assert.equal(result.block, false);
  });
  test("Case 4: write to <root>/.gsd/worktrees-extra/M001/app.js (prefix trick) is blocked", () => {
    projectRoot = makeProject("worktree");
    const target = join(projectRoot, ".gsd", "worktrees-extra", "M001", "app.js");
    const result = shouldBlockWorktreeWrite("write", target, projectRoot, false, null);
    assert.equal(result.block, true);
    assert.match(result.reason ?? "", /HARD BLOCK/);
  });
  test("Case 5: isolation=none \u2192 allow", () => {
    projectRoot = makeProject("none");
    const result = shouldBlockWorktreeWrite(
      "write",
      join(projectRoot, "app.js"),
      projectRoot,
      false,
      null
    );
    assert.equal(result.block, false);
  });
  test("Case 6: isolation=worktree, auto active, effectiveBasePath inside worktree \u2192 allow", () => {
    projectRoot = makeProject("worktree");
    const inside = join(projectRoot, ".gsd", "worktrees", "M001");
    mkdirSync(inside, { recursive: true });
    const result = shouldBlockWorktreeWrite(
      "write",
      join(inside, "src", "app.js"),
      inside,
      /* isAutoLive */
      true,
      null
    );
    assert.equal(result.block, false);
  });
  test("Case 7: isolation=worktree, auto active, effectiveBasePath is project root (cwd never flipped) \u2192 block", () => {
    projectRoot = makeProject("worktree");
    const result = shouldBlockWorktreeWrite(
      "write",
      join(projectRoot, "app.js"),
      projectRoot,
      /* isAutoLive */
      true,
      null
    );
    assert.equal(result.block, true);
    assert.match(result.reason ?? "", /HARD BLOCK/);
  });
  test("Case 8: bootstrap unit type active \u2192 allow", () => {
    projectRoot = makeProject("worktree");
    for (const unitType of ["discuss-milestone", "plan-milestone", "init"]) {
      const result = shouldBlockWorktreeWrite(
        "write",
        join(projectRoot, "app.js"),
        projectRoot,
        false,
        unitType
      );
      assert.equal(result.block, false, `unit ${unitType} should bypass the guard`);
    }
  });
  test("Case 9: GSD_DISABLE_WORKTREE_WRITE_GUARD=1 \u2192 allow", () => {
    projectRoot = makeProject("worktree");
    process.env.GSD_DISABLE_WORKTREE_WRITE_GUARD = "1";
    const result = shouldBlockWorktreeWrite(
      "write",
      join(projectRoot, "app.js"),
      projectRoot,
      false,
      null
    );
    assert.equal(result.block, false);
  });
  test("non-planning tools (read/grep/bash) pass through unconditionally", () => {
    projectRoot = makeProject("worktree");
    for (const tool of ["read", "grep", "bash", "ls"]) {
      const result = shouldBlockWorktreeWrite(
        tool,
        join(projectRoot, "app.js"),
        projectRoot,
        false,
        null
      );
      assert.equal(result.block, false, `tool ${tool} must not be gated`);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrdHJlZS13cml0ZS1nYXRlLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRC0yIHdvcmt0cmVlLWlzb2xhdGlvbiB3cml0ZSBnYXRlICgjNTE5OSkuXG4vL1xuLy8gUmVncmVzc2lvbiBjb3ZlcmFnZSBmb3Igc2hvdWxkQmxvY2tXb3JrdHJlZVdyaXRlIFx1MjAxNCB0aGUgaGVscGVyIHRoYXQgcHJldmVudHNcbi8vIHRoZSBMTE0gZnJvbSBhdXRob3JpbmcgY29kZSBhdCB0aGUgcHJvamVjdCByb290IHdoZW4gYGdpdC5pc29sYXRpb246IHdvcmt0cmVlYFxuLy8gaXMgY29uZmlndXJlZCBidXQgYXV0by1tb2RlIChhbmQgaXRzIHBvc3QtdW5pdCBjb21taXQgcGlwZWxpbmUpIGhhc24ndCBydW4uXG4vLyBXaXRob3V0IHRoaXMgZ2F0ZSwgd3JpdGVzIHNpbGVudGx5IG9ycGhhbiBvdXRzaWRlIGdpdCBoaXN0b3J5LlxuLy9cbi8vIFRlc3Qgc2V0dXAgY3JlYXRlcyBhIGZyZXNoIHRlbXAgcHJvamVjdCBmb3IgZWFjaCBpc29sYXRpb24gY2FzZSwgd3JpdGVzIGFcbi8vIGAuZ3NkL1BSRUZFUkVOQ0VTLm1kYCB3aXRoIGBpc29sYXRpb246IFwid29ya3RyZWVcImAsIGFuZCBleGVyY2lzZXMgdGhlIGhlbHBlclxuLy8gYWdhaW5zdCB0aGUgOSBzY2VuYXJpb3MgbGlzdGVkIGluIHRoZSBpc3N1ZS4gTm8gc291cmNlLWdyZXAgdGVzdHMgXHUyMDE0IGV2ZXJ5XG4vLyBhc3NlcnRpb24gZXhlcmNpc2VzIHRoZSByZWFsIHByZWRpY2F0ZS5cblxuaW1wb3J0IHsgdGVzdCwgZGVzY3JpYmUsIGJlZm9yZUVhY2gsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkaXJTeW5jLCBta2R0ZW1wU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5pbXBvcnQgeyBzaG91bGRCbG9ja1dvcmt0cmVlV3JpdGUgfSBmcm9tIFwiLi4vYm9vdHN0cmFwL3dyaXRlLWdhdGUuanNcIjtcbmltcG9ydCB7IGludmFsaWRhdGVBbGxDYWNoZXMgfSBmcm9tIFwiLi4vY2FjaGUuanNcIjtcblxuZnVuY3Rpb24gbWFrZVByb2plY3QoaXNvbGF0aW9uOiBcIm5vbmVcIiB8IFwid29ya3RyZWVcIiB8IFwiYnJhbmNoXCIgfCBudWxsKTogc3RyaW5nIHtcbiAgY29uc3Qgcm9vdCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwid3Qtd3JpdGUtZ2F0ZS1cIikpO1xuICBpZiAoaXNvbGF0aW9uICE9PSBudWxsKSB7XG4gICAgbWtkaXJTeW5jKGpvaW4ocm9vdCwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihyb290LCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSxcbiAgICAgIGAtLS1cXG5naXQ6XFxuICBpc29sYXRpb246IFwiJHtpc29sYXRpb259XCJcXG4tLS1cXG5gLFxuICAgICk7XG4gIH1cbiAgaW52YWxpZGF0ZUFsbENhY2hlcygpO1xuICByZXR1cm4gcm9vdDtcbn1cblxuY29uc3QgUExBTk5JTkdfV1JJVEVfVE9PTFMgPSBbXCJ3cml0ZVwiLCBcImVkaXRcIiwgXCJtdWx0aV9lZGl0XCIsIFwibm90ZWJvb2tfZWRpdFwiXTtcblxuZGVzY3JpYmUoXCJzaG91bGRCbG9ja1dvcmt0cmVlV3JpdGUgKCM1MTk5KVwiLCAoKSA9PiB7XG4gIGxldCBwcm9qZWN0Um9vdDogc3RyaW5nO1xuICBsZXQgcHJldkRpc2FibGVFbnY6IHN0cmluZyB8IHVuZGVmaW5lZDtcblxuICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICBwcmV2RGlzYWJsZUVudiA9IHByb2Nlc3MuZW52LkdTRF9ESVNBQkxFX1dPUktUUkVFX1dSSVRFX0dVQVJEO1xuICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfRElTQUJMRV9XT1JLVFJFRV9XUklURV9HVUFSRDtcbiAgfSk7XG5cbiAgYWZ0ZXJFYWNoKCgpID0+IHtcbiAgICBpZiAocHJvamVjdFJvb3QpIHtcbiAgICAgIHRyeSB7IHJtU3luYyhwcm9qZWN0Um9vdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHsgLyogYmVzdC1lZmZvcnQgKi8gfVxuICAgIH1cbiAgICBpZiAocHJldkRpc2FibGVFbnYgPT09IHVuZGVmaW5lZCkge1xuICAgICAgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9ESVNBQkxFX1dPUktUUkVFX1dSSVRFX0dVQVJEO1xuICAgIH0gZWxzZSB7XG4gICAgICBwcm9jZXNzLmVudi5HU0RfRElTQUJMRV9XT1JLVFJFRV9XUklURV9HVUFSRCA9IHByZXZEaXNhYmxlRW52O1xuICAgIH1cbiAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJDYXNlIDE6IGV2ZXJ5IFBMQU5OSU5HX1dSSVRFX1RPT0xTIHZhcmlhbnQgd3JpdGluZyB0byA8cm9vdD4vYXBwLmpzIGlzIGJsb2NrZWRcIiwgKCkgPT4ge1xuICAgIHByb2plY3RSb290ID0gbWFrZVByb2plY3QoXCJ3b3JrdHJlZVwiKTtcbiAgICBmb3IgKGNvbnN0IHRvb2wgb2YgUExBTk5JTkdfV1JJVEVfVE9PTFMpIHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHNob3VsZEJsb2NrV29ya3RyZWVXcml0ZShcbiAgICAgICAgdG9vbCxcbiAgICAgICAgam9pbihwcm9qZWN0Um9vdCwgXCJhcHAuanNcIiksXG4gICAgICAgIHByb2plY3RSb290LFxuICAgICAgICAvKiBpc0F1dG9MaXZlICovIGZhbHNlLFxuICAgICAgICAvKiB1bml0VHlwZSAqLyBudWxsLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYmxvY2ssIHRydWUsIGB0b29sICR7dG9vbH0gc2hvdWxkIGJlIGJsb2NrZWRgKTtcbiAgICAgIGFzc2VydC5tYXRjaChyZXN1bHQucmVhc29uID8/IFwiXCIsIC9IQVJEIEJMT0NLLyk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiQ2FzZSAyOiB3cml0ZSB0byA8cm9vdD4vLmdzZC9QUk9KRUNULm1kIGlzIGFsbG93ZWRcIiwgKCkgPT4ge1xuICAgIHByb2plY3RSb290ID0gbWFrZVByb2plY3QoXCJ3b3JrdHJlZVwiKTtcbiAgICBjb25zdCByZXN1bHQgPSBzaG91bGRCbG9ja1dvcmt0cmVlV3JpdGUoXG4gICAgICBcIndyaXRlXCIsXG4gICAgICBqb2luKHByb2plY3RSb290LCBcIi5nc2RcIiwgXCJQUk9KRUNULm1kXCIpLFxuICAgICAgcHJvamVjdFJvb3QsXG4gICAgICBmYWxzZSxcbiAgICAgIG51bGwsXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmJsb2NrLCBmYWxzZSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJDYXNlIDM6IHdyaXRlIGluc2lkZSA8cm9vdD4vLmdzZC93b3JrdHJlZXMvTTAwMS8gaXMgYWxsb3dlZFwiLCAoKSA9PiB7XG4gICAgcHJvamVjdFJvb3QgPSBtYWtlUHJvamVjdChcIndvcmt0cmVlXCIpO1xuICAgIGNvbnN0IHRhcmdldCA9IGpvaW4ocHJvamVjdFJvb3QsIFwiLmdzZFwiLCBcIndvcmt0cmVlc1wiLCBcIk0wMDFcIiwgXCJzcmNcIiwgXCJhcHAuanNcIik7XG4gICAgY29uc3QgcmVzdWx0ID0gc2hvdWxkQmxvY2tXb3JrdHJlZVdyaXRlKFwiZWRpdFwiLCB0YXJnZXQsIHByb2plY3RSb290LCBmYWxzZSwgbnVsbCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5ibG9jaywgZmFsc2UpO1xuICB9KTtcblxuICB0ZXN0KFwiQ2FzZSA0OiB3cml0ZSB0byA8cm9vdD4vLmdzZC93b3JrdHJlZXMtZXh0cmEvTTAwMS9hcHAuanMgKHByZWZpeCB0cmljaykgaXMgYmxvY2tlZFwiLCAoKSA9PiB7XG4gICAgcHJvamVjdFJvb3QgPSBtYWtlUHJvamVjdChcIndvcmt0cmVlXCIpO1xuICAgIGNvbnN0IHRhcmdldCA9IGpvaW4ocHJvamVjdFJvb3QsIFwiLmdzZFwiLCBcIndvcmt0cmVlcy1leHRyYVwiLCBcIk0wMDFcIiwgXCJhcHAuanNcIik7XG4gICAgY29uc3QgcmVzdWx0ID0gc2hvdWxkQmxvY2tXb3JrdHJlZVdyaXRlKFwid3JpdGVcIiwgdGFyZ2V0LCBwcm9qZWN0Um9vdCwgZmFsc2UsIG51bGwpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYmxvY2ssIHRydWUpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQucmVhc29uID8/IFwiXCIsIC9IQVJEIEJMT0NLLyk7XG4gIH0pO1xuXG4gIHRlc3QoXCJDYXNlIDU6IGlzb2xhdGlvbj1ub25lIFx1MjE5MiBhbGxvd1wiLCAoKSA9PiB7XG4gICAgcHJvamVjdFJvb3QgPSBtYWtlUHJvamVjdChcIm5vbmVcIik7XG4gICAgY29uc3QgcmVzdWx0ID0gc2hvdWxkQmxvY2tXb3JrdHJlZVdyaXRlKFxuICAgICAgXCJ3cml0ZVwiLFxuICAgICAgam9pbihwcm9qZWN0Um9vdCwgXCJhcHAuanNcIiksXG4gICAgICBwcm9qZWN0Um9vdCxcbiAgICAgIGZhbHNlLFxuICAgICAgbnVsbCxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYmxvY2ssIGZhbHNlKTtcbiAgfSk7XG5cbiAgdGVzdChcIkNhc2UgNjogaXNvbGF0aW9uPXdvcmt0cmVlLCBhdXRvIGFjdGl2ZSwgZWZmZWN0aXZlQmFzZVBhdGggaW5zaWRlIHdvcmt0cmVlIFx1MjE5MiBhbGxvd1wiLCAoKSA9PiB7XG4gICAgcHJvamVjdFJvb3QgPSBtYWtlUHJvamVjdChcIndvcmt0cmVlXCIpO1xuICAgIGNvbnN0IGluc2lkZSA9IGpvaW4ocHJvamVjdFJvb3QsIFwiLmdzZFwiLCBcIndvcmt0cmVlc1wiLCBcIk0wMDFcIik7XG4gICAgbWtkaXJTeW5jKGluc2lkZSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgY29uc3QgcmVzdWx0ID0gc2hvdWxkQmxvY2tXb3JrdHJlZVdyaXRlKFxuICAgICAgXCJ3cml0ZVwiLFxuICAgICAgam9pbihpbnNpZGUsIFwic3JjXCIsIFwiYXBwLmpzXCIpLFxuICAgICAgaW5zaWRlLFxuICAgICAgLyogaXNBdXRvTGl2ZSAqLyB0cnVlLFxuICAgICAgbnVsbCxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYmxvY2ssIGZhbHNlKTtcbiAgfSk7XG5cbiAgdGVzdChcIkNhc2UgNzogaXNvbGF0aW9uPXdvcmt0cmVlLCBhdXRvIGFjdGl2ZSwgZWZmZWN0aXZlQmFzZVBhdGggaXMgcHJvamVjdCByb290IChjd2QgbmV2ZXIgZmxpcHBlZCkgXHUyMTkyIGJsb2NrXCIsICgpID0+IHtcbiAgICBwcm9qZWN0Um9vdCA9IG1ha2VQcm9qZWN0KFwid29ya3RyZWVcIik7XG4gICAgY29uc3QgcmVzdWx0ID0gc2hvdWxkQmxvY2tXb3JrdHJlZVdyaXRlKFxuICAgICAgXCJ3cml0ZVwiLFxuICAgICAgam9pbihwcm9qZWN0Um9vdCwgXCJhcHAuanNcIiksXG4gICAgICBwcm9qZWN0Um9vdCxcbiAgICAgIC8qIGlzQXV0b0xpdmUgKi8gdHJ1ZSxcbiAgICAgIG51bGwsXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmJsb2NrLCB0cnVlKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LnJlYXNvbiA/PyBcIlwiLCAvSEFSRCBCTE9DSy8pO1xuICB9KTtcblxuICB0ZXN0KFwiQ2FzZSA4OiBib290c3RyYXAgdW5pdCB0eXBlIGFjdGl2ZSBcdTIxOTIgYWxsb3dcIiwgKCkgPT4ge1xuICAgIHByb2plY3RSb290ID0gbWFrZVByb2plY3QoXCJ3b3JrdHJlZVwiKTtcbiAgICBmb3IgKGNvbnN0IHVuaXRUeXBlIG9mIFtcImRpc2N1c3MtbWlsZXN0b25lXCIsIFwicGxhbi1taWxlc3RvbmVcIiwgXCJpbml0XCJdKSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBzaG91bGRCbG9ja1dvcmt0cmVlV3JpdGUoXG4gICAgICAgIFwid3JpdGVcIixcbiAgICAgICAgam9pbihwcm9qZWN0Um9vdCwgXCJhcHAuanNcIiksXG4gICAgICAgIHByb2plY3RSb290LFxuICAgICAgICBmYWxzZSxcbiAgICAgICAgdW5pdFR5cGUsXG4gICAgICApO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5ibG9jaywgZmFsc2UsIGB1bml0ICR7dW5pdFR5cGV9IHNob3VsZCBieXBhc3MgdGhlIGd1YXJkYCk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiQ2FzZSA5OiBHU0RfRElTQUJMRV9XT1JLVFJFRV9XUklURV9HVUFSRD0xIFx1MjE5MiBhbGxvd1wiLCAoKSA9PiB7XG4gICAgcHJvamVjdFJvb3QgPSBtYWtlUHJvamVjdChcIndvcmt0cmVlXCIpO1xuICAgIHByb2Nlc3MuZW52LkdTRF9ESVNBQkxFX1dPUktUUkVFX1dSSVRFX0dVQVJEID0gXCIxXCI7XG4gICAgY29uc3QgcmVzdWx0ID0gc2hvdWxkQmxvY2tXb3JrdHJlZVdyaXRlKFxuICAgICAgXCJ3cml0ZVwiLFxuICAgICAgam9pbihwcm9qZWN0Um9vdCwgXCJhcHAuanNcIiksXG4gICAgICBwcm9qZWN0Um9vdCxcbiAgICAgIGZhbHNlLFxuICAgICAgbnVsbCxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYmxvY2ssIGZhbHNlKTtcbiAgfSk7XG5cbiAgdGVzdChcIm5vbi1wbGFubmluZyB0b29scyAocmVhZC9ncmVwL2Jhc2gpIHBhc3MgdGhyb3VnaCB1bmNvbmRpdGlvbmFsbHlcIiwgKCkgPT4ge1xuICAgIHByb2plY3RSb290ID0gbWFrZVByb2plY3QoXCJ3b3JrdHJlZVwiKTtcbiAgICBmb3IgKGNvbnN0IHRvb2wgb2YgW1wicmVhZFwiLCBcImdyZXBcIiwgXCJiYXNoXCIsIFwibHNcIl0pIHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHNob3VsZEJsb2NrV29ya3RyZWVXcml0ZShcbiAgICAgICAgdG9vbCxcbiAgICAgICAgam9pbihwcm9qZWN0Um9vdCwgXCJhcHAuanNcIiksXG4gICAgICAgIHByb2plY3RSb290LFxuICAgICAgICBmYWxzZSxcbiAgICAgICAgbnVsbCxcbiAgICAgICk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmJsb2NrLCBmYWxzZSwgYHRvb2wgJHt0b29sfSBtdXN0IG5vdCBiZSBnYXRlZGApO1xuICAgIH1cbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVlBLFNBQVMsTUFBTSxVQUFVLFlBQVksaUJBQWlCO0FBQ3RELE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsYUFBYSxRQUFRLHFCQUFxQjtBQUM5RCxTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBRXJCLFNBQVMsZ0NBQWdDO0FBQ3pDLFNBQVMsMkJBQTJCO0FBRXBDLFNBQVMsWUFBWSxXQUEwRDtBQUM3RSxRQUFNLE9BQU8sWUFBWSxLQUFLLE9BQU8sR0FBRyxnQkFBZ0IsQ0FBQztBQUN6RCxNQUFJLGNBQWMsTUFBTTtBQUN0QixjQUFVLEtBQUssTUFBTSxNQUFNLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNqRDtBQUFBLE1BQ0UsS0FBSyxNQUFNLFFBQVEsZ0JBQWdCO0FBQUEsTUFDbkM7QUFBQTtBQUFBLGdCQUE0QixTQUFTO0FBQUE7QUFBQTtBQUFBLElBQ3ZDO0FBQUEsRUFDRjtBQUNBLHNCQUFvQjtBQUNwQixTQUFPO0FBQ1Q7QUFFQSxNQUFNLHVCQUF1QixDQUFDLFNBQVMsUUFBUSxjQUFjLGVBQWU7QUFFNUUsU0FBUyxvQ0FBb0MsTUFBTTtBQUNqRCxNQUFJO0FBQ0osTUFBSTtBQUVKLGFBQVcsTUFBTTtBQUNmLHFCQUFpQixRQUFRLElBQUk7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
