import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDbTools } from "../bootstrap/db-tools.js";
import { registerDynamicTools, ensureDbOpen, safeWorkspaceCwd } from "../bootstrap/dynamic-tools.js";
import { registerExecTools } from "../bootstrap/exec-tools.js";
import { registerJournalTools } from "../bootstrap/journal-tools.js";
import { registerMemoryTools } from "../bootstrap/memory-tools.js";
import { registerQueryTools } from "../bootstrap/query-tools.js";
async function withDeletedCwd(fn) {
  const previousCwd = process.cwd();
  const previousProjectRoot = process.env.GSD_PROJECT_ROOT;
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-safe-cwd-project-"));
  const removedCwd = mkdtempSync(join(tmpdir(), "gsd-removed-cwd-"));
  process.env.GSD_PROJECT_ROOT = projectRoot;
  process.chdir(removedCwd);
  rmSync(removedCwd, { recursive: true, force: true });
  try {
    assert.throws(() => process.cwd(), /ENOENT/);
    await fn(projectRoot);
  } finally {
    process.chdir(previousCwd);
    if (previousProjectRoot === void 0) delete process.env.GSD_PROJECT_ROOT;
    else process.env.GSD_PROJECT_ROOT = previousProjectRoot;
    rmSync(projectRoot, { recursive: true, force: true });
  }
}
function collectTools(register) {
  const tools = [];
  register({
    registerTool(tool) {
      tools.push(tool);
    }
  });
  return tools;
}
test("safeWorkspaceCwd falls back to captured project root when cwd was removed", async () => {
  await withDeletedCwd((projectRoot) => {
    assert.equal(safeWorkspaceCwd(), projectRoot);
  });
});
test("ensureDbOpen default path does not throw when cwd was removed", async () => {
  await withDeletedCwd(async () => {
    assert.equal(await ensureDbOpen(), false);
  });
});
test("dynamic tools register when cwd was removed", async () => {
  await withDeletedCwd(() => {
    const tools = collectTools(registerDynamicTools);
    assert.equal(tools.length, 4);
  });
});
test("db-backed tool fallbacks return normal unavailable-db errors when cwd was removed", async () => {
  await withDeletedCwd(async () => {
    const tools = collectTools(registerDbTools);
    const decisionSave = tools.find((tool) => tool.name === "gsd_decision_save");
    const result = await decisionSave.execute(
      "call-1",
      {
        scope: "test",
        decision: "Handle deleted cwd",
        choice: "Use captured project root",
        rationale: "The worktree cwd may disappear during cleanup."
      },
      void 0,
      void 0,
      void 0
    );
    assert.equal(result.details.error, "db_unavailable");
  });
});
test("memory and query tools do not throw when cwd was removed", async () => {
  await withDeletedCwd(async () => {
    const memoryTools = collectTools(registerMemoryTools);
    const queryTools = collectTools(registerQueryTools);
    await assert.doesNotReject(
      () => memoryTools.find((tool) => tool.name === "memory_query").execute(
        "call-1",
        { query: "cwd fallback" },
        void 0,
        void 0,
        void 0
      )
    );
    await assert.doesNotReject(
      () => queryTools.find((tool) => tool.name === "gsd_milestone_status").execute(
        "call-2",
        { milestoneId: "M001" },
        void 0,
        void 0,
        void 0
      )
    );
  });
});
test("journal and exec tools do not throw when cwd was removed", async () => {
  await withDeletedCwd(async () => {
    const journalTools = collectTools(registerJournalTools);
    const execTools = collectTools(registerExecTools);
    await assert.doesNotReject(
      () => journalTools.find((tool) => tool.name === "gsd_journal_query").execute(
        "call-1",
        { limit: 1 },
        void 0,
        void 0,
        void 0
      )
    );
    await assert.doesNotReject(
      () => execTools.find((tool) => tool.name === "gsd_resume").execute(
        "call-2",
        {},
        void 0,
        void 0,
        void 0
      )
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jd2QtZmFsbGJhY2staGFyZGVuaW5nLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBCZWhhdmlvciB0ZXN0cyBmb3IgZGVsZXRlZC1jd2QgZmFsbGJhY2sgaGFuZGxpbmcuXG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmltcG9ydCB7IHJlZ2lzdGVyRGJUb29scyB9IGZyb20gXCIuLi9ib290c3RyYXAvZGItdG9vbHMudHNcIjtcbmltcG9ydCB7IHJlZ2lzdGVyRHluYW1pY1Rvb2xzLCBlbnN1cmVEYk9wZW4sIHNhZmVXb3Jrc3BhY2VDd2QgfSBmcm9tIFwiLi4vYm9vdHN0cmFwL2R5bmFtaWMtdG9vbHMudHNcIjtcbmltcG9ydCB7IHJlZ2lzdGVyRXhlY1Rvb2xzIH0gZnJvbSBcIi4uL2Jvb3RzdHJhcC9leGVjLXRvb2xzLnRzXCI7XG5pbXBvcnQgeyByZWdpc3RlckpvdXJuYWxUb29scyB9IGZyb20gXCIuLi9ib290c3RyYXAvam91cm5hbC10b29scy50c1wiO1xuaW1wb3J0IHsgcmVnaXN0ZXJNZW1vcnlUb29scyB9IGZyb20gXCIuLi9ib290c3RyYXAvbWVtb3J5LXRvb2xzLnRzXCI7XG5pbXBvcnQgeyByZWdpc3RlclF1ZXJ5VG9vbHMgfSBmcm9tIFwiLi4vYm9vdHN0cmFwL3F1ZXJ5LXRvb2xzLnRzXCI7XG5cbmFzeW5jIGZ1bmN0aW9uIHdpdGhEZWxldGVkQ3dkKGZuOiAocHJvamVjdFJvb3Q6IHN0cmluZykgPT4gUHJvbWlzZTx2b2lkPiB8IHZvaWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgcHJldmlvdXNDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCBwcmV2aW91c1Byb2plY3RSb290ID0gcHJvY2Vzcy5lbnYuR1NEX1BST0pFQ1RfUk9PVDtcbiAgY29uc3QgcHJvamVjdFJvb3QgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1zYWZlLWN3ZC1wcm9qZWN0LVwiKSk7XG4gIGNvbnN0IHJlbW92ZWRDd2QgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1yZW1vdmVkLWN3ZC1cIikpO1xuXG4gIHByb2Nlc3MuZW52LkdTRF9QUk9KRUNUX1JPT1QgPSBwcm9qZWN0Um9vdDtcbiAgcHJvY2Vzcy5jaGRpcihyZW1vdmVkQ3dkKTtcbiAgcm1TeW5jKHJlbW92ZWRDd2QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcblxuICB0cnkge1xuICAgIGFzc2VydC50aHJvd3MoKCkgPT4gcHJvY2Vzcy5jd2QoKSwgL0VOT0VOVC8pO1xuICAgIGF3YWl0IGZuKHByb2plY3RSb290KTtcbiAgfSBmaW5hbGx5IHtcbiAgICBwcm9jZXNzLmNoZGlyKHByZXZpb3VzQ3dkKTtcbiAgICBpZiAocHJldmlvdXNQcm9qZWN0Um9vdCA9PT0gdW5kZWZpbmVkKSBkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX1BST0pFQ1RfUk9PVDtcbiAgICBlbHNlIHByb2Nlc3MuZW52LkdTRF9QUk9KRUNUX1JPT1QgPSBwcmV2aW91c1Byb2plY3RSb290O1xuICAgIHJtU3luYyhwcm9qZWN0Um9vdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNvbGxlY3RUb29scyhyZWdpc3RlcjogKHBpOiBhbnkpID0+IHZvaWQpOiBhbnlbXSB7XG4gIGNvbnN0IHRvb2xzOiBhbnlbXSA9IFtdO1xuICByZWdpc3Rlcih7XG4gICAgcmVnaXN0ZXJUb29sKHRvb2w6IGFueSkge1xuICAgICAgdG9vbHMucHVzaCh0b29sKTtcbiAgICB9LFxuICB9KTtcbiAgcmV0dXJuIHRvb2xzO1xufVxuXG50ZXN0KFwic2FmZVdvcmtzcGFjZUN3ZCBmYWxscyBiYWNrIHRvIGNhcHR1cmVkIHByb2plY3Qgcm9vdCB3aGVuIGN3ZCB3YXMgcmVtb3ZlZFwiLCBhc3luYyAoKSA9PiB7XG4gIGF3YWl0IHdpdGhEZWxldGVkQ3dkKChwcm9qZWN0Um9vdCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChzYWZlV29ya3NwYWNlQ3dkKCksIHByb2plY3RSb290KTtcbiAgfSk7XG59KTtcblxudGVzdChcImVuc3VyZURiT3BlbiBkZWZhdWx0IHBhdGggZG9lcyBub3QgdGhyb3cgd2hlbiBjd2Qgd2FzIHJlbW92ZWRcIiwgYXN5bmMgKCkgPT4ge1xuICBhd2FpdCB3aXRoRGVsZXRlZEN3ZChhc3luYyAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKGF3YWl0IGVuc3VyZURiT3BlbigpLCBmYWxzZSk7XG4gIH0pO1xufSk7XG5cbnRlc3QoXCJkeW5hbWljIHRvb2xzIHJlZ2lzdGVyIHdoZW4gY3dkIHdhcyByZW1vdmVkXCIsIGFzeW5jICgpID0+IHtcbiAgYXdhaXQgd2l0aERlbGV0ZWRDd2QoKCkgPT4ge1xuICAgIGNvbnN0IHRvb2xzID0gY29sbGVjdFRvb2xzKHJlZ2lzdGVyRHluYW1pY1Rvb2xzKTtcbiAgICBhc3NlcnQuZXF1YWwodG9vbHMubGVuZ3RoLCA0KTtcbiAgfSk7XG59KTtcblxudGVzdChcImRiLWJhY2tlZCB0b29sIGZhbGxiYWNrcyByZXR1cm4gbm9ybWFsIHVuYXZhaWxhYmxlLWRiIGVycm9ycyB3aGVuIGN3ZCB3YXMgcmVtb3ZlZFwiLCBhc3luYyAoKSA9PiB7XG4gIGF3YWl0IHdpdGhEZWxldGVkQ3dkKGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB0b29scyA9IGNvbGxlY3RUb29scyhyZWdpc3RlckRiVG9vbHMpO1xuICAgIGNvbnN0IGRlY2lzaW9uU2F2ZSA9IHRvb2xzLmZpbmQoKHRvb2wpID0+IHRvb2wubmFtZSA9PT0gXCJnc2RfZGVjaXNpb25fc2F2ZVwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRlY2lzaW9uU2F2ZS5leGVjdXRlKFxuICAgICAgXCJjYWxsLTFcIixcbiAgICAgIHtcbiAgICAgICAgc2NvcGU6IFwidGVzdFwiLFxuICAgICAgICBkZWNpc2lvbjogXCJIYW5kbGUgZGVsZXRlZCBjd2RcIixcbiAgICAgICAgY2hvaWNlOiBcIlVzZSBjYXB0dXJlZCBwcm9qZWN0IHJvb3RcIixcbiAgICAgICAgcmF0aW9uYWxlOiBcIlRoZSB3b3JrdHJlZSBjd2QgbWF5IGRpc2FwcGVhciBkdXJpbmcgY2xlYW51cC5cIixcbiAgICAgIH0sXG4gICAgICB1bmRlZmluZWQsXG4gICAgICB1bmRlZmluZWQsXG4gICAgICB1bmRlZmluZWQsXG4gICAgKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZGV0YWlscy5lcnJvciwgXCJkYl91bmF2YWlsYWJsZVwiKTtcbiAgfSk7XG59KTtcblxudGVzdChcIm1lbW9yeSBhbmQgcXVlcnkgdG9vbHMgZG8gbm90IHRocm93IHdoZW4gY3dkIHdhcyByZW1vdmVkXCIsIGFzeW5jICgpID0+IHtcbiAgYXdhaXQgd2l0aERlbGV0ZWRDd2QoYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IG1lbW9yeVRvb2xzID0gY29sbGVjdFRvb2xzKHJlZ2lzdGVyTWVtb3J5VG9vbHMpO1xuICAgIGNvbnN0IHF1ZXJ5VG9vbHMgPSBjb2xsZWN0VG9vbHMocmVnaXN0ZXJRdWVyeVRvb2xzKTtcblxuICAgIGF3YWl0IGFzc2VydC5kb2VzTm90UmVqZWN0KCgpID0+XG4gICAgICBtZW1vcnlUb29scy5maW5kKCh0b29sKSA9PiB0b29sLm5hbWUgPT09IFwibWVtb3J5X3F1ZXJ5XCIpLmV4ZWN1dGUoXG4gICAgICAgIFwiY2FsbC0xXCIsXG4gICAgICAgIHsgcXVlcnk6IFwiY3dkIGZhbGxiYWNrXCIgfSxcbiAgICAgICAgdW5kZWZpbmVkLFxuICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICksXG4gICAgKTtcbiAgICBhd2FpdCBhc3NlcnQuZG9lc05vdFJlamVjdCgoKSA9PlxuICAgICAgcXVlcnlUb29scy5maW5kKCh0b29sKSA9PiB0b29sLm5hbWUgPT09IFwiZ3NkX21pbGVzdG9uZV9zdGF0dXNcIikuZXhlY3V0ZShcbiAgICAgICAgXCJjYWxsLTJcIixcbiAgICAgICAgeyBtaWxlc3RvbmVJZDogXCJNMDAxXCIgfSxcbiAgICAgICAgdW5kZWZpbmVkLFxuICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICksXG4gICAgKTtcbiAgfSk7XG59KTtcblxudGVzdChcImpvdXJuYWwgYW5kIGV4ZWMgdG9vbHMgZG8gbm90IHRocm93IHdoZW4gY3dkIHdhcyByZW1vdmVkXCIsIGFzeW5jICgpID0+IHtcbiAgYXdhaXQgd2l0aERlbGV0ZWRDd2QoYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGpvdXJuYWxUb29scyA9IGNvbGxlY3RUb29scyhyZWdpc3RlckpvdXJuYWxUb29scyk7XG4gICAgY29uc3QgZXhlY1Rvb2xzID0gY29sbGVjdFRvb2xzKHJlZ2lzdGVyRXhlY1Rvb2xzKTtcblxuICAgIGF3YWl0IGFzc2VydC5kb2VzTm90UmVqZWN0KCgpID0+XG4gICAgICBqb3VybmFsVG9vbHMuZmluZCgodG9vbCkgPT4gdG9vbC5uYW1lID09PSBcImdzZF9qb3VybmFsX3F1ZXJ5XCIpLmV4ZWN1dGUoXG4gICAgICAgIFwiY2FsbC0xXCIsXG4gICAgICAgIHsgbGltaXQ6IDEgfSxcbiAgICAgICAgdW5kZWZpbmVkLFxuICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICksXG4gICAgKTtcbiAgICBhd2FpdCBhc3NlcnQuZG9lc05vdFJlamVjdCgoKSA9PlxuICAgICAgZXhlY1Rvb2xzLmZpbmQoKHRvb2wpID0+IHRvb2wubmFtZSA9PT0gXCJnc2RfcmVzdW1lXCIpLmV4ZWN1dGUoXG4gICAgICAgIFwiY2FsbC0yXCIsXG4gICAgICAgIHt9LFxuICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICAgdW5kZWZpbmVkLFxuICAgICAgKSxcbiAgICApO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBRUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsY0FBYztBQUNwQyxTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBRXJCLFNBQVMsdUJBQXVCO0FBQ2hDLFNBQVMsc0JBQXNCLGNBQWMsd0JBQXdCO0FBQ3JFLFNBQVMseUJBQXlCO0FBQ2xDLFNBQVMsNEJBQTRCO0FBQ3JDLFNBQVMsMkJBQTJCO0FBQ3BDLFNBQVMsMEJBQTBCO0FBRW5DLGVBQWUsZUFBZSxJQUFrRTtBQUM5RixRQUFNLGNBQWMsUUFBUSxJQUFJO0FBQ2hDLFFBQU0sc0JBQXNCLFFBQVEsSUFBSTtBQUN4QyxRQUFNLGNBQWMsWUFBWSxLQUFLLE9BQU8sR0FBRyx1QkFBdUIsQ0FBQztBQUN2RSxRQUFNLGFBQWEsWUFBWSxLQUFLLE9BQU8sR0FBRyxrQkFBa0IsQ0FBQztBQUVqRSxVQUFRLElBQUksbUJBQW1CO0FBQy9CLFVBQVEsTUFBTSxVQUFVO0FBQ3hCLFNBQU8sWUFBWSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUVuRCxNQUFJO0FBQ0YsV0FBTyxPQUFPLE1BQU0sUUFBUSxJQUFJLEdBQUcsUUFBUTtBQUMzQyxVQUFNLEdBQUcsV0FBVztBQUFBLEVBQ3RCLFVBQUU7QUFDQSxZQUFRLE1BQU0sV0FBVztBQUN6QixRQUFJLHdCQUF3QixPQUFXLFFBQU8sUUFBUSxJQUFJO0FBQUEsUUFDckQsU0FBUSxJQUFJLG1CQUFtQjtBQUNwQyxXQUFPLGFBQWEsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxF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
