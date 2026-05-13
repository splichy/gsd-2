import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupAfterLoopExit, rerootCommandSession, stopAuto } from "../auto.js";
import { autoSession } from "../auto-runtime-state.js";
import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.js";
import { WorktreeLifecycle } from "../worktree-lifecycle.js";
test("cleanupAfterLoopExit preserves paused auto badge after provider pause", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-paused-cleanup-"));
  const previousCwd = process.cwd();
  const statuses = [];
  autoSession.reset();
  autoSession.active = true;
  autoSession.paused = true;
  autoSession.basePath = join(base, ".gsd", "worktrees", "M001");
  autoSession.originalBasePath = base;
  try {
    await cleanupAfterLoopExit({
      ui: {
        setStatus: (key, value) => {
          statuses.push([key, value]);
        },
        setWidget: () => {
        },
        notify: () => {
        }
      }
    });
    assert.equal(statuses.some(([key]) => key === "gsd-auto"), false);
    assert.equal(autoSession.active, false);
    assert.equal(autoSession.paused, true);
  } finally {
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});
test("cleanupAfterLoopExit clears status and progress widget without replacing outcome surface", async () => {
  const statusCalls = [];
  const widgetCalls = [];
  autoSession.reset();
  autoSession.active = true;
  autoSession.paused = false;
  try {
    await cleanupAfterLoopExit({
      hasUI: false,
      ui: {
        setStatus: (...args) => statusCalls.push(args),
        setWidget: (...args) => widgetCalls.push(args),
        notify: () => {
        }
      }
    });
    assert.deepEqual(statusCalls, [["gsd-auto", void 0]]);
    assert.equal(
      widgetCalls.some((args) => Array.isArray(args) && args[0] === "gsd-progress" && args[1] === void 0),
      true,
      "cleanup must clear the stale auto progress widget"
    );
    assert.equal(
      widgetCalls.some((args) => Array.isArray(args) && args[0] === "gsd-outcome"),
      false,
      "cleanup must not replace the auto deck with a generic loop-ended card"
    );
    assert.equal(autoSession.active, false);
    assert.equal(autoSession.paused, false);
  } finally {
    autoSession.reset();
  }
});
test("cleanupAfterLoopExit clears progress widget after stopAuto reset", async () => {
  const statusCalls = [];
  const widgetCalls = [];
  autoSession.reset();
  autoSession.active = true;
  autoSession.paused = false;
  autoSession.completionStopInProgress = true;
  autoSession.resetAfterStop({ preserveCompletionSurface: true });
  try {
    await cleanupAfterLoopExit({
      hasUI: true,
      ui: {
        setStatus: (...args) => statusCalls.push(args),
        setWidget: (...args) => widgetCalls.push(args),
        setHeader: () => {
        },
        notify: () => {
        }
      }
    });
    assert.deepEqual(statusCalls, [["gsd-auto", void 0]]);
    assert.equal(
      widgetCalls.some((args) => Array.isArray(args) && args[0] === "gsd-progress" && args[1] === void 0),
      true,
      "completion cleanup must clear the stale progress widget"
    );
    assert.equal(
      widgetCalls.some((args) => Array.isArray(args) && args[0] === "gsd-outcome"),
      false,
      "completion cleanup must not replace the roll-up with a generic outcome card"
    );
    assert.equal(autoSession.completionStopInProgress, false);
  } finally {
    autoSession.reset();
  }
});
test("cleanupAfterLoopExit restores project root through lifecycle and preserves chdir", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-cleanup-lifecycle-"));
  const worktree = join(base, ".gsd", "worktrees", "M001");
  const previousCwd = process.cwd();
  let restoreCalls = 0;
  const originalRestore = WorktreeLifecycle.prototype.restoreToProjectRoot;
  t.mock.method(WorktreeLifecycle.prototype, "restoreToProjectRoot", function() {
    restoreCalls += 1;
    return originalRestore.call(this);
  });
  mkdirSync(worktree, { recursive: true });
  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = worktree;
  autoSession.originalBasePath = base;
  try {
    await cleanupAfterLoopExit({
      ui: {
        setStatus: () => {
        },
        setWidget: () => {
        },
        notify: () => {
        }
      }
    });
    assert.equal(restoreCalls, 1);
    assert.equal(autoSession.basePath, base);
    assert.equal(realpathSync(process.cwd()), realpathSync(base));
  } finally {
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});
test("cleanupAfterLoopExit keeps cleanup best-effort when lifecycle restore throws", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-cleanup-restore-throw-"));
  const worktree = join(base, ".gsd", "worktrees", "M001");
  const previousCwd = process.cwd();
  let restoreCalls = 0;
  t.mock.method(WorktreeLifecycle.prototype, "restoreToProjectRoot", function() {
    restoreCalls += 1;
    const sRef = this;
    sRef.s.basePath = sRef.s.originalBasePath;
    try {
      process.chdir(sRef.s.basePath);
    } catch {
    }
    throw new Error("restore failed");
  });
  mkdirSync(worktree, { recursive: true });
  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = worktree;
  autoSession.originalBasePath = base;
  try {
    await cleanupAfterLoopExit({
      ui: {
        setStatus: () => {
        },
        setWidget: () => {
        },
        notify: () => {
        }
      }
    });
    assert.equal(restoreCalls, 1);
    assert.equal(autoSession.basePath, base);
    assert.equal(realpathSync(process.cwd()), realpathSync(base));
  } finally {
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});
test("rerootCommandSession refreshes command workspace to project root", async () => {
  const calls = [];
  const result = await rerootCommandSession(
    {
      newSession: async ({ workspaceRoot }) => {
        calls.push(workspaceRoot);
        return { cancelled: false };
      }
    },
    "/project/root"
  );
  assert.deepEqual(result, { status: "ok" });
  assert.deepEqual(calls, ["/project/root"]);
});
test("stopAuto completion closeout reroots session, restores cwd, and preserves final widget", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-completion-stop-"));
  const previousCwd = process.cwd();
  const widgetCalls = [];
  const notifications = [];
  const newSessionWorkspaces = [];
  let restoreCalls = 0;
  const originalRestore = WorktreeLifecycle.prototype.restoreToProjectRoot;
  t.mock.method(WorktreeLifecycle.prototype, "restoreToProjectRoot", function() {
    restoreCalls += 1;
    return originalRestore.call(this);
  });
  const milestoneDir = join(base, ".gsd", "milestones", "M003");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M003-SUMMARY.md"), [
    "---",
    "id: M003",
    'title: "Budget tracking"',
    "status: complete",
    "key_decisions:",
    "  - Keep completion closeout in the same TUI surface.",
    "key_files:",
    "  - src/resources/extensions/gsd/auto-dashboard.ts",
    "lessons_learned:",
    "  - Milestone endings need report output, not auto-loop status.",
    "---",
    "",
    "# M003: Budget tracking",
    "",
    "**Added budget warning output and provider roll-up details.**",
    "",
    "## Success Criteria Results",
    "",
    "Budget warnings appear at milestone completion.",
    "",
    "## Definition of Done Results",
    "",
    "Completion leaves the report surface visible.",
    "",
    "## Requirement Outcomes",
    "",
    "Users can see what shipped without opening a fresh session.",
    "",
    "## Deviations",
    "",
    "None.",
    "",
    "## Follow-ups",
    "",
    "None.",
    ""
  ].join("\n"), "utf-8");
  autoSession.reset();
  openDatabase(join(base, "gsd-test.db"));
  insertMilestone({ id: "M003", title: "Budget tracking", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M003", title: "Complete slice", status: "complete", sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M003", title: "Done slice", status: "done", sequence: 2 });
  insertSlice({ id: "S03", milestoneId: "M003", title: "Pending slice", status: "active", sequence: 3 });
  autoSession.active = true;
  autoSession.paused = false;
  autoSession.basePath = join(base, ".gsd", "worktrees", "M003");
  autoSession.originalBasePath = base;
  autoSession.currentMilestoneId = "M003";
  autoSession.autoStartTime = Date.now() - 6e4;
  autoSession.cmdCtx = {
    newSession: async ({ workspaceRoot }) => {
      newSessionWorkspaces.push(workspaceRoot);
      widgetCalls.push(["gsd-progress", void 0]);
      return { cancelled: false };
    },
    sessionManager: {
      getEntries: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 100, cacheRead: 900 }
          }
        }
      ]
    },
    getContextUsage: () => ({ percent: 0.9, contextWindow: 1e6 }),
    model: { contextWindow: 1e6 }
  };
  try {
    await stopAuto(
      {
        hasUI: true,
        ui: {
          setStatus: () => {
          },
          setWidget: (key, value) => {
            widgetCalls.push([key, value]);
          },
          setHeader: () => {
          },
          notify: (message) => {
            notifications.push(message);
          }
        },
        modelRegistry: { find: () => null }
      },
      { events: { emit: () => {
      } } },
      "Milestone M003 complete",
      {
        completionWidget: {
          milestoneId: "M003",
          milestoneTitle: "Budget tracking"
        }
      }
    );
    assert.deepEqual(newSessionWorkspaces, [base], "completion stop must reroot command session to original project root");
    assert.equal(restoreCalls, 1, "completion stop must restore project root through lifecycle");
    assert.equal(realpathSync(process.cwd()), realpathSync(base), "completion stop must chdir back to project root");
    assert.ok(
      widgetCalls.some(([key, value]) => key === "gsd-progress" && typeof value === "function"),
      "completion stop must install a final progress widget"
    );
    const lastProgressWidget = widgetCalls.filter(([key]) => key === "gsd-progress").at(-1);
    assert.equal(typeof lastProgressWidget?.[1], "function", "completion stop must leave the final progress widget installed after reroot");
    const factory = lastProgressWidget?.[1];
    const component = factory(
      { requestRender() {
      } },
      { fg: (_color, text) => text, bold: (text) => text }
    );
    const output = component.render(140).join("\n");
    assert.match(output, /Milestone M003 roll-up/);
    assert.match(output, /Outcome/);
    assert.match(output, /Added budget warning output/);
    assert.match(output, /Verification/);
    assert.match(output, /Files: src\/resources\/extensions\/gsd\/auto-dashboard\.ts/);
    assert.match(output, /Lessons: Milestone endings need report output/);
    assert.match(output, /2\/3 slices/);
    assert.match(output, /Next/);
    assert.match(output, /Review the roll-up/);
    assert.match(output, /\/gsd auto for next milestone/);
    assert.doesNotMatch(output, /COMPLETE-MILESTONE/);
    assert.doesNotMatch(output, /\/gsd auto to resume/);
    assert.ok(
      notifications.some((message) => message.includes("Milestone M003 complete. Auto-mode finished this milestone.")),
      "completion stop notification should describe completion, not an aborted pause"
    );
    assert.ok(
      notifications.every((message) => !message.includes("/gsd auto to resume")),
      "completion stop notification must not tell users to resume a finished auto run"
    );
    assert.ok(
      widgetCalls.every(([key, value]) => key !== "gsd-outcome" || value === void 0),
      "completion stop should use the roll-up as the single final surface"
    );
  } finally {
    try {
      closeDatabase();
    } catch {
    }
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hdXRvLXBhdXNlZC11aS1jbGVhbnVwLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBCZWhhdmlvciB0ZXN0cyBmb3IgYXV0by1sb29wIGNsZWFudXAgYWZ0ZXIgcGF1c2VkIHByb3ZpZGVyIGV4aXRzLlxuaW1wb3J0IHsgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkaXJTeW5jLCBta2R0ZW1wU3luYywgcmVhbHBhdGhTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmltcG9ydCB7IGNsZWFudXBBZnRlckxvb3BFeGl0LCByZXJvb3RDb21tYW5kU2Vzc2lvbiwgc3RvcEF1dG8gfSBmcm9tIFwiLi4vYXV0by50c1wiO1xuaW1wb3J0IHsgYXV0b1Nlc3Npb24gfSBmcm9tIFwiLi4vYXV0by1ydW50aW1lLXN0YXRlLnRzXCI7XG5pbXBvcnQgeyBjbG9zZURhdGFiYXNlLCBpbnNlcnRNaWxlc3RvbmUsIGluc2VydFNsaWNlLCBvcGVuRGF0YWJhc2UgfSBmcm9tIFwiLi4vZ3NkLWRiLnRzXCI7XG5pbXBvcnQgeyBXb3JrdHJlZUxpZmVjeWNsZSB9IGZyb20gXCIuLi93b3JrdHJlZS1saWZlY3ljbGUudHNcIjtcblxudGVzdChcImNsZWFudXBBZnRlckxvb3BFeGl0IHByZXNlcnZlcyBwYXVzZWQgYXV0byBiYWRnZSBhZnRlciBwcm92aWRlciBwYXVzZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1wYXVzZWQtY2xlYW51cC1cIikpO1xuICBjb25zdCBwcmV2aW91c0N3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gIGNvbnN0IHN0YXR1c2VzOiBBcnJheTxbc3RyaW5nLCBzdHJpbmcgfCB1bmRlZmluZWRdPiA9IFtdO1xuXG4gIGF1dG9TZXNzaW9uLnJlc2V0KCk7XG4gIGF1dG9TZXNzaW9uLmFjdGl2ZSA9IHRydWU7XG4gIGF1dG9TZXNzaW9uLnBhdXNlZCA9IHRydWU7XG4gIGF1dG9TZXNzaW9uLmJhc2VQYXRoID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiwgXCJNMDAxXCIpO1xuICBhdXRvU2Vzc2lvbi5vcmlnaW5hbEJhc2VQYXRoID0gYmFzZTtcblxuICB0cnkge1xuICAgIGF3YWl0IGNsZWFudXBBZnRlckxvb3BFeGl0KHtcbiAgICAgIHVpOiB7XG4gICAgICAgIHNldFN0YXR1czogKGtleTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkKSA9PiB7XG4gICAgICAgICAgc3RhdHVzZXMucHVzaChba2V5LCB2YWx1ZV0pO1xuICAgICAgICB9LFxuICAgICAgICBzZXRXaWRnZXQ6ICgpID0+IHt9LFxuICAgICAgICBub3RpZnk6ICgpID0+IHt9LFxuICAgICAgfSxcbiAgICB9IGFzIGFueSk7XG5cbiAgICBhc3NlcnQuZXF1YWwoc3RhdHVzZXMuc29tZSgoW2tleV0pID0+IGtleSA9PT0gXCJnc2QtYXV0b1wiKSwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChhdXRvU2Vzc2lvbi5hY3RpdmUsIGZhbHNlKTtcbiAgICBhc3NlcnQuZXF1YWwoYXV0b1Nlc3Npb24ucGF1c2VkLCB0cnVlKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhdXRvU2Vzc2lvbi5yZXNldCgpO1xuICAgIHByb2Nlc3MuY2hkaXIocHJldmlvdXNDd2QpO1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiY2xlYW51cEFmdGVyTG9vcEV4aXQgY2xlYXJzIHN0YXR1cyBhbmQgcHJvZ3Jlc3Mgd2lkZ2V0IHdpdGhvdXQgcmVwbGFjaW5nIG91dGNvbWUgc3VyZmFjZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHN0YXR1c0NhbGxzOiB1bmtub3duW10gPSBbXTtcbiAgY29uc3Qgd2lkZ2V0Q2FsbHM6IHVua25vd25bXSA9IFtdO1xuXG4gIGF1dG9TZXNzaW9uLnJlc2V0KCk7XG4gIGF1dG9TZXNzaW9uLmFjdGl2ZSA9IHRydWU7XG4gIGF1dG9TZXNzaW9uLnBhdXNlZCA9IGZhbHNlO1xuXG4gIHRyeSB7XG4gICAgYXdhaXQgY2xlYW51cEFmdGVyTG9vcEV4aXQoe1xuICAgICAgaGFzVUk6IGZhbHNlLFxuICAgICAgdWk6IHtcbiAgICAgICAgc2V0U3RhdHVzOiAoLi4uYXJnczogdW5rbm93bltdKSA9PiBzdGF0dXNDYWxscy5wdXNoKGFyZ3MpLFxuICAgICAgICBzZXRXaWRnZXQ6ICguLi5hcmdzOiB1bmtub3duW10pID0+IHdpZGdldENhbGxzLnB1c2goYXJncyksXG4gICAgICAgIG5vdGlmeTogKCkgPT4ge30sXG4gICAgICB9LFxuICAgIH0gYXMgYW55KTtcblxuICAgIGFzc2VydC5kZWVwRXF1YWwoc3RhdHVzQ2FsbHMsIFtbXCJnc2QtYXV0b1wiLCB1bmRlZmluZWRdXSk7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgd2lkZ2V0Q2FsbHMuc29tZSgoYXJncykgPT4gQXJyYXkuaXNBcnJheShhcmdzKSAmJiBhcmdzWzBdID09PSBcImdzZC1wcm9ncmVzc1wiICYmIGFyZ3NbMV0gPT09IHVuZGVmaW5lZCksXG4gICAgICB0cnVlLFxuICAgICAgXCJjbGVhbnVwIG11c3QgY2xlYXIgdGhlIHN0YWxlIGF1dG8gcHJvZ3Jlc3Mgd2lkZ2V0XCIsXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICB3aWRnZXRDYWxscy5zb21lKChhcmdzKSA9PiBBcnJheS5pc0FycmF5KGFyZ3MpICYmIGFyZ3NbMF0gPT09IFwiZ3NkLW91dGNvbWVcIiksXG4gICAgICBmYWxzZSxcbiAgICAgIFwiY2xlYW51cCBtdXN0IG5vdCByZXBsYWNlIHRoZSBhdXRvIGRlY2sgd2l0aCBhIGdlbmVyaWMgbG9vcC1lbmRlZCBjYXJkXCIsXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwoYXV0b1Nlc3Npb24uYWN0aXZlLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGF1dG9TZXNzaW9uLnBhdXNlZCwgZmFsc2UpO1xuICB9IGZpbmFsbHkge1xuICAgIGF1dG9TZXNzaW9uLnJlc2V0KCk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiY2xlYW51cEFmdGVyTG9vcEV4aXQgY2xlYXJzIHByb2dyZXNzIHdpZGdldCBhZnRlciBzdG9wQXV0byByZXNldFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHN0YXR1c0NhbGxzOiB1bmtub3duW10gPSBbXTtcbiAgY29uc3Qgd2lkZ2V0Q2FsbHM6IHVua25vd25bXSA9IFtdO1xuXG4gIGF1dG9TZXNzaW9uLnJlc2V0KCk7XG4gIGF1dG9TZXNzaW9uLmFjdGl2ZSA9IHRydWU7XG4gIGF1dG9TZXNzaW9uLnBhdXNlZCA9IGZhbHNlO1xuICBhdXRvU2Vzc2lvbi5jb21wbGV0aW9uU3RvcEluUHJvZ3Jlc3MgPSB0cnVlO1xuICBhdXRvU2Vzc2lvbi5yZXNldEFmdGVyU3RvcCh7IHByZXNlcnZlQ29tcGxldGlvblN1cmZhY2U6IHRydWUgfSk7XG5cbiAgdHJ5IHtcbiAgICBhd2FpdCBjbGVhbnVwQWZ0ZXJMb29wRXhpdCh7XG4gICAgICBoYXNVSTogdHJ1ZSxcbiAgICAgIHVpOiB7XG4gICAgICAgIHNldFN0YXR1czogKC4uLmFyZ3M6IHVua25vd25bXSkgPT4gc3RhdHVzQ2FsbHMucHVzaChhcmdzKSxcbiAgICAgICAgc2V0V2lkZ2V0OiAoLi4uYXJnczogdW5rbm93bltdKSA9PiB3aWRnZXRDYWxscy5wdXNoKGFyZ3MpLFxuICAgICAgICBzZXRIZWFkZXI6ICgpID0+IHt9LFxuICAgICAgICBub3RpZnk6ICgpID0+IHt9LFxuICAgICAgfSxcbiAgICB9IGFzIGFueSk7XG5cbiAgICBhc3NlcnQuZGVlcEVxdWFsKHN0YXR1c0NhbGxzLCBbW1wiZ3NkLWF1dG9cIiwgdW5kZWZpbmVkXV0pO1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHdpZGdldENhbGxzLnNvbWUoKGFyZ3MpID0+IEFycmF5LmlzQXJyYXkoYXJncykgJiYgYXJnc1swXSA9PT0gXCJnc2QtcHJvZ3Jlc3NcIiAmJiBhcmdzWzFdID09PSB1bmRlZmluZWQpLFxuICAgICAgdHJ1ZSxcbiAgICAgIFwiY29tcGxldGlvbiBjbGVhbnVwIG11c3QgY2xlYXIgdGhlIHN0YWxlIHByb2dyZXNzIHdpZGdldFwiLFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgd2lkZ2V0Q2FsbHMuc29tZSgoYXJncykgPT4gQXJyYXkuaXNBcnJheShhcmdzKSAmJiBhcmdzWzBdID09PSBcImdzZC1vdXRjb21lXCIpLFxuICAgICAgZmFsc2UsXG4gICAgICBcImNvbXBsZXRpb24gY2xlYW51cCBtdXN0IG5vdCByZXBsYWNlIHRoZSByb2xsLXVwIHdpdGggYSBnZW5lcmljIG91dGNvbWUgY2FyZFwiLFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKGF1dG9TZXNzaW9uLmNvbXBsZXRpb25TdG9wSW5Qcm9ncmVzcywgZmFsc2UpO1xuICB9IGZpbmFsbHkge1xuICAgIGF1dG9TZXNzaW9uLnJlc2V0KCk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiY2xlYW51cEFmdGVyTG9vcEV4aXQgcmVzdG9yZXMgcHJvamVjdCByb290IHRocm91Z2ggbGlmZWN5Y2xlIGFuZCBwcmVzZXJ2ZXMgY2hkaXJcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWNsZWFudXAtbGlmZWN5Y2xlLVwiKSk7XG4gIGNvbnN0IHdvcmt0cmVlID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiwgXCJNMDAxXCIpO1xuICBjb25zdCBwcmV2aW91c0N3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gIGxldCByZXN0b3JlQ2FsbHMgPSAwO1xuICBjb25zdCBvcmlnaW5hbFJlc3RvcmUgPSBXb3JrdHJlZUxpZmVjeWNsZS5wcm90b3R5cGUucmVzdG9yZVRvUHJvamVjdFJvb3Q7XG4gIHQubW9jay5tZXRob2QoV29ya3RyZWVMaWZlY3ljbGUucHJvdG90eXBlLCBcInJlc3RvcmVUb1Byb2plY3RSb290XCIsIGZ1bmN0aW9uICh0aGlzOiBXb3JrdHJlZUxpZmVjeWNsZSkge1xuICAgIHJlc3RvcmVDYWxscyArPSAxO1xuICAgIHJldHVybiBvcmlnaW5hbFJlc3RvcmUuY2FsbCh0aGlzKTtcbiAgfSk7XG5cbiAgbWtkaXJTeW5jKHdvcmt0cmVlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgYXV0b1Nlc3Npb24ucmVzZXQoKTtcbiAgYXV0b1Nlc3Npb24uYWN0aXZlID0gdHJ1ZTtcbiAgYXV0b1Nlc3Npb24uYmFzZVBhdGggPSB3b3JrdHJlZTtcbiAgYXV0b1Nlc3Npb24ub3JpZ2luYWxCYXNlUGF0aCA9IGJhc2U7XG5cbiAgdHJ5IHtcbiAgICBhd2FpdCBjbGVhbnVwQWZ0ZXJMb29wRXhpdCh7XG4gICAgICB1aToge1xuICAgICAgICBzZXRTdGF0dXM6ICgpID0+IHt9LFxuICAgICAgICBzZXRXaWRnZXQ6ICgpID0+IHt9LFxuICAgICAgICBub3RpZnk6ICgpID0+IHt9LFxuICAgICAgfSxcbiAgICB9IGFzIGFueSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdG9yZUNhbGxzLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwoYXV0b1Nlc3Npb24uYmFzZVBhdGgsIGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZWFscGF0aFN5bmMocHJvY2Vzcy5jd2QoKSksIHJlYWxwYXRoU3luYyhiYXNlKSk7XG4gIH0gZmluYWxseSB7XG4gICAgYXV0b1Nlc3Npb24ucmVzZXQoKTtcbiAgICBwcm9jZXNzLmNoZGlyKHByZXZpb3VzQ3dkKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcImNsZWFudXBBZnRlckxvb3BFeGl0IGtlZXBzIGNsZWFudXAgYmVzdC1lZmZvcnQgd2hlbiBsaWZlY3ljbGUgcmVzdG9yZSB0aHJvd3NcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWNsZWFudXAtcmVzdG9yZS10aHJvdy1cIikpO1xuICBjb25zdCB3b3JrdHJlZSA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwid29ya3RyZWVzXCIsIFwiTTAwMVwiKTtcbiAgY29uc3QgcHJldmlvdXNDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBsZXQgcmVzdG9yZUNhbGxzID0gMDtcbiAgLy8gQURSLTAxNiBwaGFzZSAzICgjNTY5Myk6IHRoZSByZWFsIGByZXN0b3JlVG9Qcm9qZWN0Um9vdGAgYXNzaWduc1xuICAvLyBgcy5iYXNlUGF0aCA9IHMub3JpZ2luYWxCYXNlUGF0aGAgQU5EIGNoZGlyJ3MgQkVGT1JFIGFueSB0aHJvd2FibGUgd29ya1xuICAvLyAocmVidWlsZEdpdFNlcnZpY2UsIGNhY2hlIGludmFsaWRhdGlvbikuIE1pcnJvciB0aGF0IG9yZGVyaW5nIGluIHRoZVxuICAvLyBtb2NrIHNvIHRoZSB0aHJvdyBzY2VuYXJpbyByZWZsZWN0cyBwcm9kdWN0aW9uOiBiYXNlUGF0aCBhbmQgY3dkIGFyZVxuICAvLyByZXN0b3JlZCBldmVuIHdoZW4gdGhlIHZlcmIgdGhyb3dzIHBhcnR3YXkgdGhyb3VnaC5cbiAgdC5tb2NrLm1ldGhvZChXb3JrdHJlZUxpZmVjeWNsZS5wcm90b3R5cGUsIFwicmVzdG9yZVRvUHJvamVjdFJvb3RcIiwgZnVuY3Rpb24gKHRoaXM6IFdvcmt0cmVlTGlmZWN5Y2xlKSB7XG4gICAgcmVzdG9yZUNhbGxzICs9IDE7XG4gICAgY29uc3Qgc1JlZiA9IHRoaXMgYXMgdW5rbm93biBhcyB7IHM6IHsgYmFzZVBhdGg6IHN0cmluZzsgb3JpZ2luYWxCYXNlUGF0aDogc3RyaW5nIH0gfTtcbiAgICBzUmVmLnMuYmFzZVBhdGggPSBzUmVmLnMub3JpZ2luYWxCYXNlUGF0aDtcbiAgICB0cnkgeyBwcm9jZXNzLmNoZGlyKHNSZWYucy5iYXNlUGF0aCk7IH0gY2F0Y2ggeyAvKiBtaXJyb3IgcmVhbCB2ZXJiJ3MgYmVzdC1lZmZvcnQgKi8gfVxuICAgIHRocm93IG5ldyBFcnJvcihcInJlc3RvcmUgZmFpbGVkXCIpO1xuICB9KTtcblxuICBta2RpclN5bmMod29ya3RyZWUsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBhdXRvU2Vzc2lvbi5yZXNldCgpO1xuICBhdXRvU2Vzc2lvbi5hY3RpdmUgPSB0cnVlO1xuICBhdXRvU2Vzc2lvbi5iYXNlUGF0aCA9IHdvcmt0cmVlO1xuICBhdXRvU2Vzc2lvbi5vcmlnaW5hbEJhc2VQYXRoID0gYmFzZTtcblxuICB0cnkge1xuICAgIGF3YWl0IGNsZWFudXBBZnRlckxvb3BFeGl0KHtcbiAgICAgIHVpOiB7XG4gICAgICAgIHNldFN0YXR1czogKCkgPT4ge30sXG4gICAgICAgIHNldFdpZGdldDogKCkgPT4ge30sXG4gICAgICAgIG5vdGlmeTogKCkgPT4ge30sXG4gICAgICB9LFxuICAgIH0gYXMgYW55KTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN0b3JlQ2FsbHMsIDEpO1xuICAgIGFzc2VydC5lcXVhbChhdXRvU2Vzc2lvbi5iYXNlUGF0aCwgYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlYWxwYXRoU3luYyhwcm9jZXNzLmN3ZCgpKSwgcmVhbHBhdGhTeW5jKGJhc2UpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhdXRvU2Vzc2lvbi5yZXNldCgpO1xuICAgIHByb2Nlc3MuY2hkaXIocHJldmlvdXNDd2QpO1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwicmVyb290Q29tbWFuZFNlc3Npb24gcmVmcmVzaGVzIGNvbW1hbmQgd29ya3NwYWNlIHRvIHByb2plY3Qgcm9vdFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGNhbGxzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXJvb3RDb21tYW5kU2Vzc2lvbihcbiAgICB7XG4gICAgICBuZXdTZXNzaW9uOiBhc3luYyAoeyB3b3Jrc3BhY2VSb290IH06IHsgd29ya3NwYWNlUm9vdDogc3RyaW5nIH0pID0+IHtcbiAgICAgICAgY2FsbHMucHVzaCh3b3Jrc3BhY2VSb290KTtcbiAgICAgICAgcmV0dXJuIHsgY2FuY2VsbGVkOiBmYWxzZSB9O1xuICAgICAgfSxcbiAgICB9IGFzIGFueSxcbiAgICBcIi9wcm9qZWN0L3Jvb3RcIixcbiAgKTtcblxuICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdCwgeyBzdGF0dXM6IFwib2tcIiB9KTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChjYWxscywgW1wiL3Byb2plY3Qvcm9vdFwiXSk7XG59KTtcblxudGVzdChcInN0b3BBdXRvIGNvbXBsZXRpb24gY2xvc2VvdXQgcmVyb290cyBzZXNzaW9uLCByZXN0b3JlcyBjd2QsIGFuZCBwcmVzZXJ2ZXMgZmluYWwgd2lkZ2V0XCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1jb21wbGV0aW9uLXN0b3AtXCIpKTtcbiAgY29uc3QgcHJldmlvdXNDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCB3aWRnZXRDYWxsczogQXJyYXk8W3N0cmluZywgdW5rbm93bl0+ID0gW107XG4gIGNvbnN0IG5vdGlmaWNhdGlvbnM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IG5ld1Nlc3Npb25Xb3Jrc3BhY2VzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgcmVzdG9yZUNhbGxzID0gMDtcbiAgY29uc3Qgb3JpZ2luYWxSZXN0b3JlID0gV29ya3RyZWVMaWZlY3ljbGUucHJvdG90eXBlLnJlc3RvcmVUb1Byb2plY3RSb290O1xuICB0Lm1vY2subWV0aG9kKFdvcmt0cmVlTGlmZWN5Y2xlLnByb3RvdHlwZSwgXCJyZXN0b3JlVG9Qcm9qZWN0Um9vdFwiLCBmdW5jdGlvbiAodGhpczogV29ya3RyZWVMaWZlY3ljbGUpIHtcbiAgICByZXN0b3JlQ2FsbHMgKz0gMTtcbiAgICByZXR1cm4gb3JpZ2luYWxSZXN0b3JlLmNhbGwodGhpcyk7XG4gIH0pO1xuICBjb25zdCBtaWxlc3RvbmVEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAzXCIpO1xuICBta2RpclN5bmMobWlsZXN0b25lRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKG1pbGVzdG9uZURpciwgXCJNMDAzLVNVTU1BUlkubWRcIiksIFtcbiAgICBcIi0tLVwiLFxuICAgIFwiaWQ6IE0wMDNcIixcbiAgICAndGl0bGU6IFwiQnVkZ2V0IHRyYWNraW5nXCInLFxuICAgIFwic3RhdHVzOiBjb21wbGV0ZVwiLFxuICAgIFwia2V5X2RlY2lzaW9uczpcIixcbiAgICBcIiAgLSBLZWVwIGNvbXBsZXRpb24gY2xvc2VvdXQgaW4gdGhlIHNhbWUgVFVJIHN1cmZhY2UuXCIsXG4gICAgXCJrZXlfZmlsZXM6XCIsXG4gICAgXCIgIC0gc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9hdXRvLWRhc2hib2FyZC50c1wiLFxuICAgIFwibGVzc29uc19sZWFybmVkOlwiLFxuICAgIFwiICAtIE1pbGVzdG9uZSBlbmRpbmdzIG5lZWQgcmVwb3J0IG91dHB1dCwgbm90IGF1dG8tbG9vcCBzdGF0dXMuXCIsXG4gICAgXCItLS1cIixcbiAgICBcIlwiLFxuICAgIFwiIyBNMDAzOiBCdWRnZXQgdHJhY2tpbmdcIixcbiAgICBcIlwiLFxuICAgIFwiKipBZGRlZCBidWRnZXQgd2FybmluZyBvdXRwdXQgYW5kIHByb3ZpZGVyIHJvbGwtdXAgZGV0YWlscy4qKlwiLFxuICAgIFwiXCIsXG4gICAgXCIjIyBTdWNjZXNzIENyaXRlcmlhIFJlc3VsdHNcIixcbiAgICBcIlwiLFxuICAgIFwiQnVkZ2V0IHdhcm5pbmdzIGFwcGVhciBhdCBtaWxlc3RvbmUgY29tcGxldGlvbi5cIixcbiAgICBcIlwiLFxuICAgIFwiIyMgRGVmaW5pdGlvbiBvZiBEb25lIFJlc3VsdHNcIixcbiAgICBcIlwiLFxuICAgIFwiQ29tcGxldGlvbiBsZWF2ZXMgdGhlIHJlcG9ydCBzdXJmYWNlIHZpc2libGUuXCIsXG4gICAgXCJcIixcbiAgICBcIiMjIFJlcXVpcmVtZW50IE91dGNvbWVzXCIsXG4gICAgXCJcIixcbiAgICBcIlVzZXJzIGNhbiBzZWUgd2hhdCBzaGlwcGVkIHdpdGhvdXQgb3BlbmluZyBhIGZyZXNoIHNlc3Npb24uXCIsXG4gICAgXCJcIixcbiAgICBcIiMjIERldmlhdGlvbnNcIixcbiAgICBcIlwiLFxuICAgIFwiTm9uZS5cIixcbiAgICBcIlwiLFxuICAgIFwiIyMgRm9sbG93LXVwc1wiLFxuICAgIFwiXCIsXG4gICAgXCJOb25lLlwiLFxuICAgIFwiXCIsXG4gIF0uam9pbihcIlxcblwiKSwgXCJ1dGYtOFwiKTtcblxuICBhdXRvU2Vzc2lvbi5yZXNldCgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcImdzZC10ZXN0LmRiXCIpKTtcbiAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwM1wiLCB0aXRsZTogXCJCdWRnZXQgdHJhY2tpbmdcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIgfSk7XG4gIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDNcIiwgdGl0bGU6IFwiQ29tcGxldGUgc2xpY2VcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIsIHNlcXVlbmNlOiAxIH0pO1xuICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMlwiLCBtaWxlc3RvbmVJZDogXCJNMDAzXCIsIHRpdGxlOiBcIkRvbmUgc2xpY2VcIiwgc3RhdHVzOiBcImRvbmVcIiwgc2VxdWVuY2U6IDIgfSk7XG4gIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAzXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDNcIiwgdGl0bGU6IFwiUGVuZGluZyBzbGljZVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIsIHNlcXVlbmNlOiAzIH0pO1xuXG4gIGF1dG9TZXNzaW9uLmFjdGl2ZSA9IHRydWU7XG4gIGF1dG9TZXNzaW9uLnBhdXNlZCA9IGZhbHNlO1xuICBhdXRvU2Vzc2lvbi5iYXNlUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwid29ya3RyZWVzXCIsIFwiTTAwM1wiKTtcbiAgYXV0b1Nlc3Npb24ub3JpZ2luYWxCYXNlUGF0aCA9IGJhc2U7XG4gIGF1dG9TZXNzaW9uLmN1cnJlbnRNaWxlc3RvbmVJZCA9IFwiTTAwM1wiO1xuICBhdXRvU2Vzc2lvbi5hdXRvU3RhcnRUaW1lID0gRGF0ZS5ub3coKSAtIDYwXzAwMDtcbiAgYXV0b1Nlc3Npb24uY21kQ3R4ID0ge1xuICAgIG5ld1Nlc3Npb246IGFzeW5jICh7IHdvcmtzcGFjZVJvb3QgfTogeyB3b3Jrc3BhY2VSb290OiBzdHJpbmcgfSkgPT4ge1xuICAgICAgbmV3U2Vzc2lvbldvcmtzcGFjZXMucHVzaCh3b3Jrc3BhY2VSb290KTtcbiAgICAgIHdpZGdldENhbGxzLnB1c2goW1wiZ3NkLXByb2dyZXNzXCIsIHVuZGVmaW5lZF0pO1xuICAgICAgcmV0dXJuIHsgY2FuY2VsbGVkOiBmYWxzZSB9O1xuICAgIH0sXG4gICAgc2Vzc2lvbk1hbmFnZXI6IHtcbiAgICAgIGdldEVudHJpZXM6ICgpID0+IFtcbiAgICAgICAge1xuICAgICAgICAgIHR5cGU6IFwibWVzc2FnZVwiLFxuICAgICAgICAgIG1lc3NhZ2U6IHtcbiAgICAgICAgICAgIHJvbGU6IFwiYXNzaXN0YW50XCIsXG4gICAgICAgICAgICB1c2FnZTogeyBpbnB1dDogMTAwLCBjYWNoZVJlYWQ6IDkwMCB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0sXG4gICAgZ2V0Q29udGV4dFVzYWdlOiAoKSA9PiAoeyBwZXJjZW50OiAwLjksIGNvbnRleHRXaW5kb3c6IDFfMDAwXzAwMCB9KSxcbiAgICBtb2RlbDogeyBjb250ZXh0V2luZG93OiAxXzAwMF8wMDAgfSxcbiAgfSBhcyBhbnk7XG5cbiAgdHJ5IHtcbiAgICBhd2FpdCBzdG9wQXV0byhcbiAgICAgIHtcbiAgICAgICAgaGFzVUk6IHRydWUsXG4gICAgICAgIHVpOiB7XG4gICAgICAgICAgc2V0U3RhdHVzOiAoKSA9PiB7fSxcbiAgICAgICAgICBzZXRXaWRnZXQ6IChrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24pID0+IHtcbiAgICAgICAgICAgIHdpZGdldENhbGxzLnB1c2goW2tleSwgdmFsdWVdKTtcbiAgICAgICAgICB9LFxuICAgICAgICAgIHNldEhlYWRlcjogKCkgPT4ge30sXG4gICAgICAgICAgbm90aWZ5OiAobWVzc2FnZTogc3RyaW5nKSA9PiB7XG4gICAgICAgICAgICBub3RpZmljYXRpb25zLnB1c2gobWVzc2FnZSk7XG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgbW9kZWxSZWdpc3RyeTogeyBmaW5kOiAoKSA9PiBudWxsIH0sXG4gICAgICB9IGFzIGFueSxcbiAgICAgIHsgZXZlbnRzOiB7IGVtaXQ6ICgpID0+IHt9IH0gfSBhcyBhbnksXG4gICAgICBcIk1pbGVzdG9uZSBNMDAzIGNvbXBsZXRlXCIsXG4gICAgICB7XG4gICAgICAgIGNvbXBsZXRpb25XaWRnZXQ6IHtcbiAgICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAzXCIsXG4gICAgICAgICAgbWlsZXN0b25lVGl0bGU6IFwiQnVkZ2V0IHRyYWNraW5nXCIsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICk7XG5cbiAgICBhc3NlcnQuZGVlcEVxdWFsKG5ld1Nlc3Npb25Xb3Jrc3BhY2VzLCBbYmFzZV0sIFwiY29tcGxldGlvbiBzdG9wIG11c3QgcmVyb290IGNvbW1hbmQgc2Vzc2lvbiB0byBvcmlnaW5hbCBwcm9qZWN0IHJvb3RcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3RvcmVDYWxscywgMSwgXCJjb21wbGV0aW9uIHN0b3AgbXVzdCByZXN0b3JlIHByb2plY3Qgcm9vdCB0aHJvdWdoIGxpZmVjeWNsZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVhbHBhdGhTeW5jKHByb2Nlc3MuY3dkKCkpLCByZWFscGF0aFN5bmMoYmFzZSksIFwiY29tcGxldGlvbiBzdG9wIG11c3QgY2hkaXIgYmFjayB0byBwcm9qZWN0IHJvb3RcIik7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgd2lkZ2V0Q2FsbHMuc29tZSgoW2tleSwgdmFsdWVdKSA9PiBrZXkgPT09IFwiZ3NkLXByb2dyZXNzXCIgJiYgdHlwZW9mIHZhbHVlID09PSBcImZ1bmN0aW9uXCIpLFxuICAgICAgXCJjb21wbGV0aW9uIHN0b3AgbXVzdCBpbnN0YWxsIGEgZmluYWwgcHJvZ3Jlc3Mgd2lkZ2V0XCIsXG4gICAgKTtcbiAgICBjb25zdCBsYXN0UHJvZ3Jlc3NXaWRnZXQgPSB3aWRnZXRDYWxscy5maWx0ZXIoKFtrZXldKSA9PiBrZXkgPT09IFwiZ3NkLXByb2dyZXNzXCIpLmF0KC0xKTtcbiAgICBhc3NlcnQuZXF1YWwodHlwZW9mIGxhc3RQcm9ncmVzc1dpZGdldD8uWzFdLCBcImZ1bmN0aW9uXCIsIFwiY29tcGxldGlvbiBzdG9wIG11c3QgbGVhdmUgdGhlIGZpbmFsIHByb2dyZXNzIHdpZGdldCBpbnN0YWxsZWQgYWZ0ZXIgcmVyb290XCIpO1xuICAgIGNvbnN0IGZhY3RvcnkgPSBsYXN0UHJvZ3Jlc3NXaWRnZXQ/LlsxXSBhcyBhbnk7XG4gICAgY29uc3QgY29tcG9uZW50ID0gZmFjdG9yeShcbiAgICAgIHsgcmVxdWVzdFJlbmRlcigpIHt9IH0sXG4gICAgICB7IGZnOiAoX2NvbG9yOiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4gdGV4dCwgYm9sZDogKHRleHQ6IHN0cmluZykgPT4gdGV4dCB9LFxuICAgICk7XG4gICAgY29uc3Qgb3V0cHV0ID0gY29tcG9uZW50LnJlbmRlcigxNDApLmpvaW4oXCJcXG5cIik7XG4gICAgYXNzZXJ0Lm1hdGNoKG91dHB1dCwgL01pbGVzdG9uZSBNMDAzIHJvbGwtdXAvKTtcbiAgICBhc3NlcnQubWF0Y2gob3V0cHV0LCAvT3V0Y29tZS8pO1xuICAgIGFzc2VydC5tYXRjaChvdXRwdXQsIC9BZGRlZCBidWRnZXQgd2FybmluZyBvdXRwdXQvKTtcbiAgICBhc3NlcnQubWF0Y2gob3V0cHV0LCAvVmVyaWZpY2F0aW9uLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKG91dHB1dCwgL0ZpbGVzOiBzcmNcXC9yZXNvdXJjZXNcXC9leHRlbnNpb25zXFwvZ3NkXFwvYXV0by1kYXNoYm9hcmRcXC50cy8pO1xuICAgIGFzc2VydC5tYXRjaChvdXRwdXQsIC9MZXNzb25zOiBNaWxlc3RvbmUgZW5kaW5ncyBuZWVkIHJlcG9ydCBvdXRwdXQvKTtcbiAgICBhc3NlcnQubWF0Y2gob3V0cHV0LCAvMlxcLzMgc2xpY2VzLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKG91dHB1dCwgL05leHQvKTtcbiAgICBhc3NlcnQubWF0Y2gob3V0cHV0LCAvUmV2aWV3IHRoZSByb2xsLXVwLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKG91dHB1dCwgL1xcL2dzZCBhdXRvIGZvciBuZXh0IG1pbGVzdG9uZS8pO1xuICAgIGFzc2VydC5kb2VzTm90TWF0Y2gob3V0cHV0LCAvQ09NUExFVEUtTUlMRVNUT05FLyk7XG4gICAgYXNzZXJ0LmRvZXNOb3RNYXRjaChvdXRwdXQsIC9cXC9nc2QgYXV0byB0byByZXN1bWUvKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBub3RpZmljYXRpb25zLnNvbWUobWVzc2FnZSA9PiBtZXNzYWdlLmluY2x1ZGVzKFwiTWlsZXN0b25lIE0wMDMgY29tcGxldGUuIEF1dG8tbW9kZSBmaW5pc2hlZCB0aGlzIG1pbGVzdG9uZS5cIikpLFxuICAgICAgXCJjb21wbGV0aW9uIHN0b3Agbm90aWZpY2F0aW9uIHNob3VsZCBkZXNjcmliZSBjb21wbGV0aW9uLCBub3QgYW4gYWJvcnRlZCBwYXVzZVwiLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgbm90aWZpY2F0aW9ucy5ldmVyeShtZXNzYWdlID0+ICFtZXNzYWdlLmluY2x1ZGVzKFwiL2dzZCBhdXRvIHRvIHJlc3VtZVwiKSksXG4gICAgICBcImNvbXBsZXRpb24gc3RvcCBub3RpZmljYXRpb24gbXVzdCBub3QgdGVsbCB1c2VycyB0byByZXN1bWUgYSBmaW5pc2hlZCBhdXRvIHJ1blwiLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgd2lkZ2V0Q2FsbHMuZXZlcnkoKFtrZXksIHZhbHVlXSkgPT4ga2V5ICE9PSBcImdzZC1vdXRjb21lXCIgfHwgdmFsdWUgPT09IHVuZGVmaW5lZCksXG4gICAgICBcImNvbXBsZXRpb24gc3RvcCBzaG91bGQgdXNlIHRoZSByb2xsLXVwIGFzIHRoZSBzaW5nbGUgZmluYWwgc3VyZmFjZVwiLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgdHJ5IHsgY2xvc2VEYXRhYmFzZSgpOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9XG4gICAgYXV0b1Nlc3Npb24ucmVzZXQoKTtcbiAgICBwcm9jZXNzLmNoZGlyKHByZXZpb3VzQ3dkKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUVBLFNBQVMsWUFBWTtBQUNyQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxXQUFXLGFBQWEsY0FBYyxRQUFRLHFCQUFxQjtBQUM1RSxTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBRXJCLFNBQVMsc0JBQXNCLHNCQUFzQixnQkFBZ0I7QUFDckUsU0FBUyxtQkFBbUI7QUFDNUIsU0FBUyxlQUFlLGlCQUFpQixhQUFhLG9CQUFvQjtBQUMxRSxTQUFTLHlCQUF5QjtBQUVsQyxLQUFL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
