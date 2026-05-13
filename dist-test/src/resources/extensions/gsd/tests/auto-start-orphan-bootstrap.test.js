import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapAutoSession } from "../auto-start.js";
import { AutoSession } from "../auto/session.js";
import {
  closeDatabase,
  insertMilestone,
  openDatabase
} from "../gsd-db.js";
function runGit(base, args) {
  return execFileSync("git", args, {
    cwd: base,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
function makeRepoWithUnmergedCompletedMilestone() {
  const base = mkdtempSync(join(tmpdir(), "gsd-orphan-bootstrap-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    '---\ngit:\n  isolation: "branch"\n---\n'
  );
  runGit(base, ["init"]);
  runGit(base, ["config", "user.email", "test@test.com"]);
  runGit(base, ["config", "user.name", "Test"]);
  writeFileSync(join(base, "README.md"), "# test\n");
  runGit(base, ["add", "-A"]);
  runGit(base, ["commit", "-m", "init"]);
  runGit(base, ["branch", "-M", "main"]);
  runGit(base, ["checkout", "-b", "milestone/M002"]);
  writeFileSync(join(base, "m002.txt"), "complete but unmerged\n");
  runGit(base, ["add", "-A"]);
  runGit(base, ["commit", "-m", "feat: M002 work"]);
  runGit(base, ["checkout", "main"]);
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M002", title: "Completed milestone", status: "complete" });
  insertMilestone({ id: "M003", title: "Next milestone", status: "active" });
  closeDatabase();
  return base;
}
function makeCtx(notifications) {
  const model = { provider: "claude-code", id: "claude-sonnet-4-6", contextWindow: 128e3 };
  return {
    ui: {
      notify: (message, level) => {
        notifications.push({ message, level });
      },
      setStatus: () => {
      },
      setWidget: () => {
      }
    },
    model,
    modelRegistry: {
      getAvailable: () => [model],
      isProviderRequestReady: () => true,
      getProviderAuthMode: () => "oauth"
    },
    sessionManager: {
      getSessionId: () => "orphan-bootstrap-test",
      getSessionFile: () => null,
      getEntries: () => []
    }
  };
}
test("bootstrap aborts before starting next milestone when completed orphan merge fails", async () => {
  const base = makeRepoWithUnmergedCompletedMilestone();
  const previousCwd = process.cwd();
  const s = new AutoSession();
  const mergeCalls = [];
  const notifications = [];
  try {
    const ready = await bootstrapAutoSession(
      s,
      makeCtx(notifications),
      {
        getThinkingLevel: () => "medium",
        getActiveTools: () => [],
        events: { emit: () => {
        } }
      },
      base,
      false,
      false,
      {
        shouldUseWorktreeIsolation: () => true,
        registerSigtermHandler: () => {
        },
        registerAutoWorkerForSession: () => {
        },
        lockBase: () => base,
        buildLifecycle: () => ({
          adoptSessionRoot: (sessionBase, originalBase) => {
            s.basePath = sessionBase;
            if (originalBase !== void 0) {
              s.originalBasePath = originalBase;
            } else if (!s.originalBasePath) {
              s.originalBasePath = sessionBase;
            }
          },
          exitMilestone: (milestoneId) => {
            mergeCalls.push(milestoneId);
            return {
              ok: false,
              reason: "teardown-failed",
              cause: new Error("synthetic merge failure")
            };
          },
          enterMilestone: () => ({ ok: true, mode: "none", path: base }),
          // ADR-016 phase 2 / B4 (#5622): the orphan-merge dance now goes
          // through `adoptOrphanWorktree`. The mock invokes the callback
          // and returns its result without exercising the swap-revert
          // protocol — this test only cares about the merge call being
          // recorded and the bootstrap returning `false` on failure.
          adoptOrphanWorktree: (_mid, _base, run) => run()
        })
      },
      {
        classification: "none",
        lock: null,
        pausedSession: null,
        state: null,
        recovery: null,
        recoveryPrompt: null,
        recoveryToolCallCount: 0,
        artifactSatisfied: false,
        hasResumableDiskState: false,
        isBootstrapCrash: false
      }
    );
    assert.equal(ready, false);
    assert.deepEqual(mergeCalls, ["M002"]);
    assert.equal(s.active, false);
    assert.match(
      notifications.map((entry) => entry.message).join("\n"),
      /Could not merge orphan milestone M002: synthetic merge failure/
    );
  } finally {
    try {
      closeDatabase();
    } catch {
    }
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hdXRvLXN0YXJ0LW9ycGhhbi1ib290c3RyYXAudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IEJvb3RzdHJhcCBiZWhhdmlvciB0ZXN0cyBmb3IgY29tcGxldGVkIG1pbGVzdG9uZSBvcnBoYW4gbWVyZ2VzLlxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBleGVjRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmltcG9ydCB7IGJvb3RzdHJhcEF1dG9TZXNzaW9uIH0gZnJvbSBcIi4uL2F1dG8tc3RhcnQudHNcIjtcbmltcG9ydCB7IEF1dG9TZXNzaW9uIH0gZnJvbSBcIi4uL2F1dG8vc2Vzc2lvbi50c1wiO1xuaW1wb3J0IHtcbiAgY2xvc2VEYXRhYmFzZSxcbiAgaW5zZXJ0TWlsZXN0b25lLFxuICBvcGVuRGF0YWJhc2UsXG59IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcblxuZnVuY3Rpb24gcnVuR2l0KGJhc2U6IHN0cmluZywgYXJnczogc3RyaW5nW10pOiBzdHJpbmcge1xuICByZXR1cm4gZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIGFyZ3MsIHtcbiAgICBjd2Q6IGJhc2UsXG4gICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gIH0pLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gbWFrZVJlcG9XaXRoVW5tZXJnZWRDb21wbGV0ZWRNaWxlc3RvbmUoKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLW9ycGhhbi1ib290c3RyYXAtXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSxcbiAgICBcIi0tLVxcbmdpdDpcXG4gIGlzb2xhdGlvbjogXFxcImJyYW5jaFxcXCJcXG4tLS1cXG5cIixcbiAgKTtcbiAgcnVuR2l0KGJhc2UsIFtcImluaXRcIl0pO1xuICBydW5HaXQoYmFzZSwgW1wiY29uZmlnXCIsIFwidXNlci5lbWFpbFwiLCBcInRlc3RAdGVzdC5jb21cIl0pO1xuICBydW5HaXQoYmFzZSwgW1wiY29uZmlnXCIsIFwidXNlci5uYW1lXCIsIFwiVGVzdFwiXSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIlJFQURNRS5tZFwiKSwgXCIjIHRlc3RcXG5cIik7XG4gIHJ1bkdpdChiYXNlLCBbXCJhZGRcIiwgXCItQVwiXSk7XG4gIHJ1bkdpdChiYXNlLCBbXCJjb21taXRcIiwgXCItbVwiLCBcImluaXRcIl0pO1xuICBydW5HaXQoYmFzZSwgW1wiYnJhbmNoXCIsIFwiLU1cIiwgXCJtYWluXCJdKTtcblxuICBydW5HaXQoYmFzZSwgW1wiY2hlY2tvdXRcIiwgXCItYlwiLCBcIm1pbGVzdG9uZS9NMDAyXCJdKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwibTAwMi50eHRcIiksIFwiY29tcGxldGUgYnV0IHVubWVyZ2VkXFxuXCIpO1xuICBydW5HaXQoYmFzZSwgW1wiYWRkXCIsIFwiLUFcIl0pO1xuICBydW5HaXQoYmFzZSwgW1wiY29tbWl0XCIsIFwiLW1cIiwgXCJmZWF0OiBNMDAyIHdvcmtcIl0pO1xuICBydW5HaXQoYmFzZSwgW1wiY2hlY2tvdXRcIiwgXCJtYWluXCJdKTtcblxuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAyXCIsIHRpdGxlOiBcIkNvbXBsZXRlZCBtaWxlc3RvbmVcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIgfSk7XG4gIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDNcIiwgdGl0bGU6IFwiTmV4dCBtaWxlc3RvbmVcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICBjbG9zZURhdGFiYXNlKCk7XG5cbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIG1ha2VDdHgobm90aWZpY2F0aW9uczogQXJyYXk8eyBtZXNzYWdlOiBzdHJpbmc7IGxldmVsPzogc3RyaW5nIH0+KSB7XG4gIGNvbnN0IG1vZGVsID0geyBwcm92aWRlcjogXCJjbGF1ZGUtY29kZVwiLCBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCBjb250ZXh0V2luZG93OiAxMjgwMDAgfTtcbiAgcmV0dXJuIHtcbiAgICB1aToge1xuICAgICAgbm90aWZ5OiAobWVzc2FnZTogc3RyaW5nLCBsZXZlbD86IHN0cmluZykgPT4ge1xuICAgICAgICBub3RpZmljYXRpb25zLnB1c2goeyBtZXNzYWdlLCBsZXZlbCB9KTtcbiAgICAgIH0sXG4gICAgICBzZXRTdGF0dXM6ICgpID0+IHt9LFxuICAgICAgc2V0V2lkZ2V0OiAoKSA9PiB7fSxcbiAgICB9LFxuICAgIG1vZGVsLFxuICAgIG1vZGVsUmVnaXN0cnk6IHtcbiAgICAgIGdldEF2YWlsYWJsZTogKCkgPT4gW21vZGVsXSxcbiAgICAgIGlzUHJvdmlkZXJSZXF1ZXN0UmVhZHk6ICgpID0+IHRydWUsXG4gICAgICBnZXRQcm92aWRlckF1dGhNb2RlOiAoKSA9PiBcIm9hdXRoXCIsXG4gICAgfSxcbiAgICBzZXNzaW9uTWFuYWdlcjoge1xuICAgICAgZ2V0U2Vzc2lvbklkOiAoKSA9PiBcIm9ycGhhbi1ib290c3RyYXAtdGVzdFwiLFxuICAgICAgZ2V0U2Vzc2lvbkZpbGU6ICgpID0+IG51bGwsXG4gICAgICBnZXRFbnRyaWVzOiAoKSA9PiBbXSxcbiAgICB9LFxuICB9O1xufVxuXG50ZXN0KFwiYm9vdHN0cmFwIGFib3J0cyBiZWZvcmUgc3RhcnRpbmcgbmV4dCBtaWxlc3RvbmUgd2hlbiBjb21wbGV0ZWQgb3JwaGFuIG1lcmdlIGZhaWxzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VSZXBvV2l0aFVubWVyZ2VkQ29tcGxldGVkTWlsZXN0b25lKCk7XG4gIGNvbnN0IHByZXZpb3VzQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3QgcyA9IG5ldyBBdXRvU2Vzc2lvbigpO1xuICBjb25zdCBtZXJnZUNhbGxzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBub3RpZmljYXRpb25zOiBBcnJheTx7IG1lc3NhZ2U6IHN0cmluZzsgbGV2ZWw/OiBzdHJpbmcgfT4gPSBbXTtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlYWR5ID0gYXdhaXQgYm9vdHN0cmFwQXV0b1Nlc3Npb24oXG4gICAgICBzLFxuICAgICAgbWFrZUN0eChub3RpZmljYXRpb25zKSBhcyBhbnksXG4gICAgICB7XG4gICAgICAgIGdldFRoaW5raW5nTGV2ZWw6ICgpID0+IFwibWVkaXVtXCIsXG4gICAgICAgIGdldEFjdGl2ZVRvb2xzOiAoKSA9PiBbXSxcbiAgICAgICAgZXZlbnRzOiB7IGVtaXQ6ICgpID0+IHt9IH0sXG4gICAgICB9IGFzIGFueSxcbiAgICAgIGJhc2UsXG4gICAgICBmYWxzZSxcbiAgICAgIGZhbHNlLFxuICAgICAge1xuICAgICAgICBzaG91bGRVc2VXb3JrdHJlZUlzb2xhdGlvbjogKCkgPT4gdHJ1ZSxcbiAgICAgICAgcmVnaXN0ZXJTaWd0ZXJtSGFuZGxlcjogKCkgPT4ge30sXG4gICAgICAgIHJlZ2lzdGVyQXV0b1dvcmtlckZvclNlc3Npb246ICgpID0+IHt9LFxuICAgICAgICBsb2NrQmFzZTogKCkgPT4gYmFzZSxcbiAgICAgICAgYnVpbGRMaWZlY3ljbGU6ICgpID0+ICh7XG4gICAgICAgICAgYWRvcHRTZXNzaW9uUm9vdDogKHNlc3Npb25CYXNlOiBzdHJpbmcsIG9yaWdpbmFsQmFzZT86IHN0cmluZykgPT4ge1xuICAgICAgICAgICAgcy5iYXNlUGF0aCA9IHNlc3Npb25CYXNlO1xuICAgICAgICAgICAgaWYgKG9yaWdpbmFsQmFzZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICAgIHMub3JpZ2luYWxCYXNlUGF0aCA9IG9yaWdpbmFsQmFzZTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIXMub3JpZ2luYWxCYXNlUGF0aCkge1xuICAgICAgICAgICAgICBzLm9yaWdpbmFsQmFzZVBhdGggPSBzZXNzaW9uQmFzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9LFxuICAgICAgICAgIGV4aXRNaWxlc3RvbmU6IChtaWxlc3RvbmVJZDogc3RyaW5nKSA9PiB7XG4gICAgICAgICAgICBtZXJnZUNhbGxzLnB1c2gobWlsZXN0b25lSWQpO1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgICAgICByZWFzb246IFwidGVhcmRvd24tZmFpbGVkXCIsXG4gICAgICAgICAgICAgIGNhdXNlOiBuZXcgRXJyb3IoXCJzeW50aGV0aWMgbWVyZ2UgZmFpbHVyZVwiKSxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgfSxcbiAgICAgICAgICBlbnRlck1pbGVzdG9uZTogKCkgPT4gKHsgb2s6IHRydWUsIG1vZGU6IFwibm9uZVwiLCBwYXRoOiBiYXNlIH0pLFxuICAgICAgICAgIC8vIEFEUi0wMTYgcGhhc2UgMiAvIEI0ICgjNTYyMik6IHRoZSBvcnBoYW4tbWVyZ2UgZGFuY2Ugbm93IGdvZXNcbiAgICAgICAgICAvLyB0aHJvdWdoIGBhZG9wdE9ycGhhbldvcmt0cmVlYC4gVGhlIG1vY2sgaW52b2tlcyB0aGUgY2FsbGJhY2tcbiAgICAgICAgICAvLyBhbmQgcmV0dXJucyBpdHMgcmVzdWx0IHdpdGhvdXQgZXhlcmNpc2luZyB0aGUgc3dhcC1yZXZlcnRcbiAgICAgICAgICAvLyBwcm90b2NvbCBcdTIwMTQgdGhpcyB0ZXN0IG9ubHkgY2FyZXMgYWJvdXQgdGhlIG1lcmdlIGNhbGwgYmVpbmdcbiAgICAgICAgICAvLyByZWNvcmRlZCBhbmQgdGhlIGJvb3RzdHJhcCByZXR1cm5pbmcgYGZhbHNlYCBvbiBmYWlsdXJlLlxuICAgICAgICAgIGFkb3B0T3JwaGFuV29ya3RyZWU6IDxUIGV4dGVuZHMgeyBtZXJnZWQ6IGJvb2xlYW4gfT4oXG4gICAgICAgICAgICBfbWlkOiBzdHJpbmcsXG4gICAgICAgICAgICBfYmFzZTogc3RyaW5nLFxuICAgICAgICAgICAgcnVuOiAoKSA9PiBULFxuICAgICAgICAgICk6IFQgPT4gcnVuKCksXG4gICAgICAgIH0pIGFzIGFueSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGNsYXNzaWZpY2F0aW9uOiBcIm5vbmVcIixcbiAgICAgICAgbG9jazogbnVsbCxcbiAgICAgICAgcGF1c2VkU2Vzc2lvbjogbnVsbCxcbiAgICAgICAgc3RhdGU6IG51bGwsXG4gICAgICAgIHJlY292ZXJ5OiBudWxsLFxuICAgICAgICByZWNvdmVyeVByb21wdDogbnVsbCxcbiAgICAgICAgcmVjb3ZlcnlUb29sQ2FsbENvdW50OiAwLFxuICAgICAgICBhcnRpZmFjdFNhdGlzZmllZDogZmFsc2UsXG4gICAgICAgIGhhc1Jlc3VtYWJsZURpc2tTdGF0ZTogZmFsc2UsXG4gICAgICAgIGlzQm9vdHN0cmFwQ3Jhc2g6IGZhbHNlLFxuICAgICAgfSxcbiAgICApO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlYWR5LCBmYWxzZSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChtZXJnZUNhbGxzLCBbXCJNMDAyXCJdKTtcbiAgICBhc3NlcnQuZXF1YWwocy5hY3RpdmUsIGZhbHNlKTtcbiAgICBhc3NlcnQubWF0Y2goXG4gICAgICBub3RpZmljYXRpb25zLm1hcCgoZW50cnkpID0+IGVudHJ5Lm1lc3NhZ2UpLmpvaW4oXCJcXG5cIiksXG4gICAgICAvQ291bGQgbm90IG1lcmdlIG9ycGhhbiBtaWxlc3RvbmUgTTAwMjogc3ludGhldGljIG1lcmdlIGZhaWx1cmUvLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgdHJ5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGNhdGNoIHt9XG4gICAgcHJvY2Vzcy5jaGRpcihwcmV2aW91c0N3ZCk7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFFQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsYUFBYSxXQUFXLFFBQVEscUJBQXFCO0FBQzlELFNBQVMsY0FBYztBQUN2QixTQUFTLFlBQVk7QUFFckIsU0FBUyw0QkFBNEI7QUFDckMsU0FBUyxtQkFBbUI7QUFDNUI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBRVAsU0FBUyxPQUFPLE1BQWMsTUFBd0I7QUFDcEQsU0FBTyxhQUFhLE9BQU8sTUFBTTtBQUFBLElBQy9CLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLE9BQU8sQ0FBQyxVQUFVLFFBQVEsTUFBTTtBQUFBLEVBQ2xDLENBQUMsRUFBRSxLQUFLO0FBQ1Y7QUFFQSxTQUFTLHlDQUFpRDtBQUN4RCxRQUFNLE9BQU8sWUFBWSxLQUFLLE9BQU8sR0FBRyx1QkFBdUIsQ0FBQztBQUNoRSxZQUFVLEtBQUssTUFBTSxRQUFRLFlBQVksR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQy9EO0FBQUEsSUFDRSxLQUFLLE1BQU0sUUFBUSxnQkFB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
