import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const ownsGsdHome = process.env.GSD_HOME_TEST_OVERRIDE === void 0;
const previousGsdHome = process.env.GSD_HOME;
const synthesizedGsdHome = join(tmpdir(), `gsd-test-home-${process.pid}-${Date.now()}`);
process.env.GSD_HOME = process.env.GSD_HOME_TEST_OVERRIDE ?? synthesizedGsdHome;
after(() => {
  if (ownsGsdHome) {
    rmSync(synthesizedGsdHome, { recursive: true, force: true });
  }
  if (previousGsdHome === void 0) {
    delete process.env.GSD_HOME;
  } else {
    process.env.GSD_HOME = previousGsdHome;
  }
});
const { dispatchDirectPhase } = await import("../auto-direct-dispatch.js");
const {
  buildDiscussMilestonePrompt,
  buildParallelResearchSlicesPrompt,
  buildRewriteDocsPrompt
} = await import("../auto-prompts.js");
const { invalidateStateCache } = await import("../state.js");
const { resolveAgentEnd, _resetPendingResolve } = await import("../auto/resolve.js");
const { runUnit } = await import("../auto/run-unit.js");
function writeMilestone(base, mid = "M001", title = "Worktree Path Injection") {
  const milestoneDir = join(base, ".gsd", "milestones", mid);
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(
    join(milestoneDir, `${mid}-CONTEXT.md`),
    `# ${mid}: ${title}

Context.
`,
    "utf-8"
  );
  writeFileSync(
    join(milestoneDir, `${mid}-ROADMAP.md`),
    [
      `# ${mid}: ${title}`,
      "",
      "## Slices",
      "",
      "- [ ] **S01: First slice** `risk:low` `depends:[]`",
      ""
    ].join("\n"),
    "utf-8"
  );
}
function makeLiveMilestoneWorktree(base, mid = "M001") {
  const worktreeRoot = join(base, ".gsd", "worktrees", mid);
  mkdirSync(worktreeRoot, { recursive: true });
  writeFileSync(
    join(worktreeRoot, ".git"),
    `gitdir: ${join(base, ".git", "worktrees", mid)}
`,
    "utf-8"
  );
  writeMilestone(worktreeRoot, mid);
  return worktreeRoot;
}
async function waitFor(condition, label) {
  const rawTimeout = process.env.READABLE_WAIT_TIMEOUT_MS;
  const parsedTimeout = rawTimeout === void 0 ? NaN : Number.parseInt(rawTimeout, 10);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 1e3;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (condition()) return;
  assert.fail(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}
test("runUnit passes basePath as workspaceRoot without changing process cwd", async (t) => {
  _resetPendingResolve();
  const originalCwd = process.cwd();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rununit-base-")));
  const drifted = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rununit-drift-")));
  t.after(() => {
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
    rmSync(drifted, { recursive: true, force: true });
  });
  process.chdir(drifted);
  let newSessionWorkspaceRoot;
  let cwdAtNewSession;
  const session = {
    active: true,
    basePath: base,
    verbose: false,
    cmdCtx: {
      newSession: (options) => {
        newSessionWorkspaceRoot = options?.workspaceRoot;
        cwdAtNewSession = process.cwd();
        return Promise.resolve({ cancelled: false });
      }
    }
  };
  const pi = {
    calls: [],
    sendMessage(...args) {
      this.calls.push(args);
    }
  };
  const ctx = { ui: { notify: () => {
  } }, model: { id: "test-model" } };
  const resultPromise = runUnit(ctx, pi, session, "task", "T01", "prompt");
  await waitFor(() => pi.calls.length === 1, "runUnit dispatch");
  resolveAgentEnd({ messages: [{ role: "assistant" }] });
  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.equal(newSessionWorkspaceRoot, base);
  assert.equal(cwdAtNewSession, drifted);
  assert.equal(process.cwd(), drifted);
});
test("runUnit does not chdir or cancel when basePath is not a live directory", async (t) => {
  _resetPendingResolve();
  const originalCwd = process.cwd();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rununit-missing-base-")));
  const drifted = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rununit-missing-drift-")));
  rmSync(base, { recursive: true, force: true });
  t.after(() => {
    process.chdir(originalCwd);
    rmSync(drifted, { recursive: true, force: true });
  });
  process.chdir(drifted);
  let newSessionWorkspaceRoot;
  const session = {
    active: true,
    basePath: base,
    verbose: false,
    cmdCtx: {
      newSession: (options) => {
        newSessionWorkspaceRoot = options?.workspaceRoot;
        return Promise.resolve({ cancelled: false });
      }
    }
  };
  const pi = {
    calls: [],
    sendMessage(...args) {
      this.calls.push(args);
    }
  };
  const ctx = { ui: { notify: () => {
  } }, model: { id: "test-model" } };
  const resultPromise = runUnit(ctx, pi, session, "task", "T01", "prompt");
  await waitFor(() => pi.calls.length === 1, "runUnit dispatch");
  resolveAgentEnd({ messages: [{ role: "assistant" }] });
  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.equal(newSessionWorkspaceRoot, base);
  assert.equal(process.cwd(), drifted);
});
test("direct dispatch redirects to the canonical milestone worktree before newSession", async (t) => {
  invalidateStateCache();
  const originalCwd = process.cwd();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-direct-base-")));
  const drifted = realpathSync(mkdtempSync(join(tmpdir(), "gsd-direct-drift-")));
  writeMilestone(base);
  const worktreeRoot = makeLiveMilestoneWorktree(base);
  t.after(() => {
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
    rmSync(drifted, { recursive: true, force: true });
    invalidateStateCache();
  });
  process.chdir(drifted);
  let newSessionWorkspaceRoot;
  let sentPrompt;
  const ctx = {
    ui: { notify: () => {
    } },
    newSession: async (options) => {
      newSessionWorkspaceRoot = options?.workspaceRoot;
      return { cancelled: false };
    }
  };
  const pi = {
    sendMessage(message) {
      sentPrompt = message.content;
    }
  };
  await dispatchDirectPhase(ctx, pi, "research-milestone", base);
  assert.equal(newSessionWorkspaceRoot, worktreeRoot);
  assert.equal(process.cwd(), drifted);
  assert.ok(sentPrompt?.includes(worktreeRoot), "prompt should name the canonical worktree root");
});
test("worktree-aware prompt builders include the explicit working directory", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-prompt-base-")));
  writeMilestone(base);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const prompts = await Promise.all([
    buildDiscussMilestonePrompt("M001", "Worktree Path Injection", base),
    buildParallelResearchSlicesPrompt(
      "M001",
      "Worktree Path Injection",
      [{ id: "S01", title: "First slice" }],
      base
    ),
    buildRewriteDocsPrompt(
      "M001",
      "Worktree Path Injection",
      null,
      base,
      [{ change: "Refresh docs", timestamp: "2026-04-27T00:00:00.000Z", appliedAt: "test" }]
    )
  ]);
  assert.ok(prompts[0].includes("## Context Mode"), "discuss-milestone should include standalone Context Mode guidance");
  assert.ok(prompts[0].includes("interview lane"), "discuss-milestone should render the interview lane");
  for (const prompt of prompts) {
    assert.match(prompt, /working directory/i);
    assert.ok(prompt.includes(base), "prompt should include the provided working directory");
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrdHJlZS1wYXRoLWluamVjdGlvbi50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCwgeyBhZnRlciB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkaXJTeW5jLCBta2R0ZW1wU3luYywgcmVhbHBhdGhTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmNvbnN0IG93bnNHc2RIb21lID0gcHJvY2Vzcy5lbnYuR1NEX0hPTUVfVEVTVF9PVkVSUklERSA9PT0gdW5kZWZpbmVkO1xuY29uc3QgcHJldmlvdXNHc2RIb21lID0gcHJvY2Vzcy5lbnYuR1NEX0hPTUU7XG5jb25zdCBzeW50aGVzaXplZEdzZEhvbWUgPSBqb2luKHRtcGRpcigpLCBgZ3NkLXRlc3QtaG9tZS0ke3Byb2Nlc3MucGlkfS0ke0RhdGUubm93KCl9YCk7XG5wcm9jZXNzLmVudi5HU0RfSE9NRSA9IHByb2Nlc3MuZW52LkdTRF9IT01FX1RFU1RfT1ZFUlJJREVcbiAgPz8gc3ludGhlc2l6ZWRHc2RIb21lO1xuXG5hZnRlcigoKSA9PiB7XG4gIGlmIChvd25zR3NkSG9tZSkge1xuICAgIHJtU3luYyhzeW50aGVzaXplZEdzZEhvbWUsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxuICBpZiAocHJldmlvdXNHc2RIb21lID09PSB1bmRlZmluZWQpIHtcbiAgICBkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX0hPTUU7XG4gIH0gZWxzZSB7XG4gICAgcHJvY2Vzcy5lbnYuR1NEX0hPTUUgPSBwcmV2aW91c0dzZEhvbWU7XG4gIH1cbn0pO1xuXG5jb25zdCB7IGRpc3BhdGNoRGlyZWN0UGhhc2UgfSA9IGF3YWl0IGltcG9ydChcIi4uL2F1dG8tZGlyZWN0LWRpc3BhdGNoLnRzXCIpO1xuY29uc3Qge1xuICBidWlsZERpc2N1c3NNaWxlc3RvbmVQcm9tcHQsXG4gIGJ1aWxkUGFyYWxsZWxSZXNlYXJjaFNsaWNlc1Byb21wdCxcbiAgYnVpbGRSZXdyaXRlRG9jc1Byb21wdCxcbn0gPSBhd2FpdCBpbXBvcnQoXCIuLi9hdXRvLXByb21wdHMudHNcIik7XG5jb25zdCB7IGludmFsaWRhdGVTdGF0ZUNhY2hlIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9zdGF0ZS50c1wiKTtcbmNvbnN0IHsgcmVzb2x2ZUFnZW50RW5kLCBfcmVzZXRQZW5kaW5nUmVzb2x2ZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vYXV0by9yZXNvbHZlLnRzXCIpO1xuY29uc3QgeyBydW5Vbml0IH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9hdXRvL3J1bi11bml0LnRzXCIpO1xuXG5mdW5jdGlvbiB3cml0ZU1pbGVzdG9uZShiYXNlOiBzdHJpbmcsIG1pZCA9IFwiTTAwMVwiLCB0aXRsZSA9IFwiV29ya3RyZWUgUGF0aCBJbmplY3Rpb25cIik6IHZvaWQge1xuICBjb25zdCBtaWxlc3RvbmVEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgbWlkKTtcbiAgbWtkaXJTeW5jKG1pbGVzdG9uZURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihtaWxlc3RvbmVEaXIsIGAke21pZH0tQ09OVEVYVC5tZGApLFxuICAgIGAjICR7bWlkfTogJHt0aXRsZX1cXG5cXG5Db250ZXh0LlxcbmAsXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4obWlsZXN0b25lRGlyLCBgJHttaWR9LVJPQURNQVAubWRgKSxcbiAgICBbXG4gICAgICBgIyAke21pZH06ICR7dGl0bGV9YCxcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFNsaWNlc1wiLFxuICAgICAgXCJcIixcbiAgICAgIFwiLSBbIF0gKipTMDE6IEZpcnN0IHNsaWNlKiogYHJpc2s6bG93YCBgZGVwZW5kczpbXWBcIixcbiAgICAgIFwiXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpLFxuICAgIFwidXRmLThcIixcbiAgKTtcbn1cblxuZnVuY3Rpb24gbWFrZUxpdmVNaWxlc3RvbmVXb3JrdHJlZShiYXNlOiBzdHJpbmcsIG1pZCA9IFwiTTAwMVwiKTogc3RyaW5nIHtcbiAgY29uc3Qgd29ya3RyZWVSb290ID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiwgbWlkKTtcbiAgbWtkaXJTeW5jKHdvcmt0cmVlUm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbih3b3JrdHJlZVJvb3QsIFwiLmdpdFwiKSxcbiAgICBgZ2l0ZGlyOiAke2pvaW4oYmFzZSwgXCIuZ2l0XCIsIFwid29ya3RyZWVzXCIsIG1pZCl9XFxuYCxcbiAgICBcInV0Zi04XCIsXG4gICk7XG4gIHdyaXRlTWlsZXN0b25lKHdvcmt0cmVlUm9vdCwgbWlkKTtcbiAgcmV0dXJuIHdvcmt0cmVlUm9vdDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gd2FpdEZvcihjb25kaXRpb246ICgpID0+IGJvb2xlYW4sIGxhYmVsOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgcmF3VGltZW91dCA9IHByb2Nlc3MuZW52LlJFQURBQkxFX1dBSVRfVElNRU9VVF9NUztcbiAgY29uc3QgcGFyc2VkVGltZW91dCA9IHJhd1RpbWVvdXQgPT09IHVuZGVmaW5lZCA/IE5hTiA6IE51bWJlci5wYXJzZUludChyYXdUaW1lb3V0LCAxMCk7XG4gIGNvbnN0IHRpbWVvdXRNcyA9IE51bWJlci5pc0Zpbml0ZShwYXJzZWRUaW1lb3V0KSAmJiBwYXJzZWRUaW1lb3V0ID4gMCA/IHBhcnNlZFRpbWVvdXQgOiAxMDAwO1xuICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyB0aW1lb3V0TXM7XG5cbiAgd2hpbGUgKERhdGUubm93KCkgPCBkZWFkbGluZSkge1xuICAgIGlmIChjb25kaXRpb24oKSkgcmV0dXJuO1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDUpKTtcbiAgfVxuICBpZiAoY29uZGl0aW9uKCkpIHJldHVybjtcbiAgYXNzZXJ0LmZhaWwoYFRpbWVkIG91dCB3YWl0aW5nIGZvciAke2xhYmVsfSBhZnRlciAke3RpbWVvdXRNc31tc2ApO1xufVxuXG50ZXN0KFwicnVuVW5pdCBwYXNzZXMgYmFzZVBhdGggYXMgd29ya3NwYWNlUm9vdCB3aXRob3V0IGNoYW5naW5nIHByb2Nlc3MgY3dkXCIsIGFzeW5jICh0KSA9PiB7XG4gIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgY29uc3Qgb3JpZ2luYWxDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCBiYXNlID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXJ1bnVuaXQtYmFzZS1cIikpKTtcbiAgY29uc3QgZHJpZnRlZCA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1ydW51bml0LWRyaWZ0LVwiKSkpO1xuICB0LmFmdGVyKCgpID0+IHtcbiAgICBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQ3dkKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIHJtU3luYyhkcmlmdGVkLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIHByb2Nlc3MuY2hkaXIoZHJpZnRlZCk7XG5cbiAgbGV0IG5ld1Nlc3Npb25Xb3Jrc3BhY2VSb290OiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGxldCBjd2RBdE5ld1Nlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgY29uc3Qgc2Vzc2lvbiA9IHtcbiAgICBhY3RpdmU6IHRydWUsXG4gICAgYmFzZVBhdGg6IGJhc2UsXG4gICAgdmVyYm9zZTogZmFsc2UsXG4gICAgY21kQ3R4OiB7XG4gICAgICBuZXdTZXNzaW9uOiAob3B0aW9ucz86IHsgd29ya3NwYWNlUm9vdD86IHN0cmluZyB9KSA9PiB7XG4gICAgICAgIG5ld1Nlc3Npb25Xb3Jrc3BhY2VSb290ID0gb3B0aW9ucz8ud29ya3NwYWNlUm9vdDtcbiAgICAgICAgY3dkQXROZXdTZXNzaW9uID0gcHJvY2Vzcy5jd2QoKTtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGNhbmNlbGxlZDogZmFsc2UgfSk7XG4gICAgICB9LFxuICAgIH0sXG4gIH0gYXMgYW55O1xuICBjb25zdCBwaSA9IHtcbiAgICBjYWxsczogW10gYXMgdW5rbm93bltdLFxuICAgIHNlbmRNZXNzYWdlKC4uLmFyZ3M6IHVua25vd25bXSkge1xuICAgICAgdGhpcy5jYWxscy5wdXNoKGFyZ3MpO1xuICAgIH0sXG4gIH0gYXMgYW55O1xuICBjb25zdCBjdHggPSB7IHVpOiB7IG5vdGlmeTogKCkgPT4ge30gfSwgbW9kZWw6IHsgaWQ6IFwidGVzdC1tb2RlbFwiIH0gfSBhcyBhbnk7XG5cbiAgY29uc3QgcmVzdWx0UHJvbWlzZSA9IHJ1blVuaXQoY3R4LCBwaSwgc2Vzc2lvbiwgXCJ0YXNrXCIsIFwiVDAxXCIsIFwicHJvbXB0XCIpO1xuICBhd2FpdCB3YWl0Rm9yKCgpID0+IHBpLmNhbGxzLmxlbmd0aCA9PT0gMSwgXCJydW5Vbml0IGRpc3BhdGNoXCIpO1xuICByZXNvbHZlQWdlbnRFbmQoeyBtZXNzYWdlczogW3sgcm9sZTogXCJhc3Npc3RhbnRcIiB9XSB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXN1bHRQcm9taXNlO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXR1cywgXCJjb21wbGV0ZWRcIik7XG4gIGFzc2VydC5lcXVhbChuZXdTZXNzaW9uV29ya3NwYWNlUm9vdCwgYmFzZSk7XG4gIGFzc2VydC5lcXVhbChjd2RBdE5ld1Nlc3Npb24sIGRyaWZ0ZWQpO1xuICBhc3NlcnQuZXF1YWwocHJvY2Vzcy5jd2QoKSwgZHJpZnRlZCk7XG59KTtcblxudGVzdChcInJ1blVuaXQgZG9lcyBub3QgY2hkaXIgb3IgY2FuY2VsIHdoZW4gYmFzZVBhdGggaXMgbm90IGEgbGl2ZSBkaXJlY3RvcnlcIiwgYXN5bmMgKHQpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBvcmlnaW5hbEN3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gIGNvbnN0IGJhc2UgPSByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcnVudW5pdC1taXNzaW5nLWJhc2UtXCIpKSk7XG4gIGNvbnN0IGRyaWZ0ZWQgPSByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcnVudW5pdC1taXNzaW5nLWRyaWZ0LVwiKSkpO1xuICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB0LmFmdGVyKCgpID0+IHtcbiAgICBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQ3dkKTtcbiAgICBybVN5bmMoZHJpZnRlZCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICBwcm9jZXNzLmNoZGlyKGRyaWZ0ZWQpO1xuXG4gIGxldCBuZXdTZXNzaW9uV29ya3NwYWNlUm9vdDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBjb25zdCBzZXNzaW9uID0ge1xuICAgIGFjdGl2ZTogdHJ1ZSxcbiAgICBiYXNlUGF0aDogYmFzZSxcbiAgICB2ZXJib3NlOiBmYWxzZSxcbiAgICBjbWRDdHg6IHtcbiAgICAgIG5ld1Nlc3Npb246IChvcHRpb25zPzogeyB3b3Jrc3BhY2VSb290Pzogc3RyaW5nIH0pID0+IHtcbiAgICAgICAgbmV3U2Vzc2lvbldvcmtzcGFjZVJvb3QgPSBvcHRpb25zPy53b3Jrc3BhY2VSb290O1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgY2FuY2VsbGVkOiBmYWxzZSB9KTtcbiAgICAgIH0sXG4gICAgfSxcbiAgfSBhcyBhbnk7XG4gIGNvbnN0IHBpID0ge1xuICAgIGNhbGxzOiBbXSBhcyB1bmtub3duW10sXG4gICAgc2VuZE1lc3NhZ2UoLi4uYXJnczogdW5rbm93bltdKSB7XG4gICAgICB0aGlzLmNhbGxzLnB1c2goYXJncyk7XG4gICAgfSxcbiAgfSBhcyBhbnk7XG4gIGNvbnN0IGN0eCA9IHsgdWk6IHsgbm90aWZ5OiAoKSA9PiB7fSB9LCBtb2RlbDogeyBpZDogXCJ0ZXN0LW1vZGVsXCIgfSB9IGFzIGFueTtcblxuICBjb25zdCByZXN1bHRQcm9taXNlID0gcnVuVW5pdChjdHgsIHBpLCBzZXNzaW9uLCBcInRhc2tcIiwgXCJUMDFcIiwgXCJwcm9tcHRcIik7XG4gIGF3YWl0IHdhaXRGb3IoKCkgPT4gcGkuY2FsbHMubGVuZ3RoID09PSAxLCBcInJ1blVuaXQgZGlzcGF0Y2hcIik7XG4gIHJlc29sdmVBZ2VudEVuZCh7IG1lc3NhZ2VzOiBbeyByb2xlOiBcImFzc2lzdGFudFwiIH1dIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlc3VsdFByb21pc2U7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdHVzLCBcImNvbXBsZXRlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKG5ld1Nlc3Npb25Xb3Jrc3BhY2VSb290LCBiYXNlKTtcbiAgYXNzZXJ0LmVxdWFsKHByb2Nlc3MuY3dkKCksIGRyaWZ0ZWQpO1xufSk7XG5cbnRlc3QoXCJkaXJlY3QgZGlzcGF0Y2ggcmVkaXJlY3RzIHRvIHRoZSBjYW5vbmljYWwgbWlsZXN0b25lIHdvcmt0cmVlIGJlZm9yZSBuZXdTZXNzaW9uXCIsIGFzeW5jICh0KSA9PiB7XG4gIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG5cbiAgY29uc3Qgb3JpZ2luYWxDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCBiYXNlID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWRpcmVjdC1iYXNlLVwiKSkpO1xuICBjb25zdCBkcmlmdGVkID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWRpcmVjdC1kcmlmdC1cIikpKTtcbiAgd3JpdGVNaWxlc3RvbmUoYmFzZSk7XG4gIGNvbnN0IHdvcmt0cmVlUm9vdCA9IG1ha2VMaXZlTWlsZXN0b25lV29ya3RyZWUoYmFzZSk7XG5cbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgcHJvY2Vzcy5jaGRpcihvcmlnaW5hbEN3ZCk7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICBybVN5bmMoZHJpZnRlZCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gIH0pO1xuXG4gIHByb2Nlc3MuY2hkaXIoZHJpZnRlZCk7XG5cbiAgbGV0IG5ld1Nlc3Npb25Xb3Jrc3BhY2VSb290OiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGxldCBzZW50UHJvbXB0OiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGNvbnN0IGN0eCA9IHtcbiAgICB1aTogeyBub3RpZnk6ICgpID0+IHt9IH0sXG4gICAgbmV3U2Vzc2lvbjogYXN5bmMgKG9wdGlvbnM/OiB7IHdvcmtzcGFjZVJvb3Q/OiBzdHJpbmcgfSkgPT4ge1xuICAgICAgbmV3U2Vzc2lvbldvcmtzcGFjZVJvb3QgPSBvcHRpb25zPy53b3Jrc3BhY2VSb290O1xuICAgICAgcmV0dXJuIHsgY2FuY2VsbGVkOiBmYWxzZSB9O1xuICAgIH0sXG4gIH0gYXMgYW55O1xuICBjb25zdCBwaSA9IHtcbiAgICBzZW5kTWVzc2FnZShtZXNzYWdlOiB7IGNvbnRlbnQ6IHN0cmluZyB9KSB7XG4gICAgICBzZW50UHJvbXB0ID0gbWVzc2FnZS5jb250ZW50O1xuICAgIH0sXG4gIH0gYXMgYW55O1xuXG4gIGF3YWl0IGRpc3BhdGNoRGlyZWN0UGhhc2UoY3R4LCBwaSwgXCJyZXNlYXJjaC1taWxlc3RvbmVcIiwgYmFzZSk7XG5cbiAgYXNzZXJ0LmVxdWFsKG5ld1Nlc3Npb25Xb3Jrc3BhY2VSb290LCB3b3JrdHJlZVJvb3QpO1xuICBhc3NlcnQuZXF1YWwocHJvY2Vzcy5jd2QoKSwgZHJpZnRlZCk7XG4gIGFzc2VydC5vayhzZW50UHJvbXB0Py5pbmNsdWRlcyh3b3JrdHJlZVJvb3QpLCBcInByb21wdCBzaG91bGQgbmFtZSB0aGUgY2Fub25pY2FsIHdvcmt0cmVlIHJvb3RcIik7XG59KTtcblxudGVzdChcIndvcmt0cmVlLWF3YXJlIHByb21wdCBidWlsZGVycyBpbmNsdWRlIHRoZSBleHBsaWNpdCB3b3JraW5nIGRpcmVjdG9yeVwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXByb21wdC1iYXNlLVwiKSkpO1xuICB3cml0ZU1pbGVzdG9uZShiYXNlKTtcbiAgdC5hZnRlcigoKSA9PiBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICBjb25zdCBwcm9tcHRzID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgIGJ1aWxkRGlzY3Vzc01pbGVzdG9uZVByb21wdChcIk0wMDFcIiwgXCJXb3JrdHJlZSBQYXRoIEluamVjdGlvblwiLCBiYXNlKSxcbiAgICBidWlsZFBhcmFsbGVsUmVzZWFyY2hTbGljZXNQcm9tcHQoXG4gICAgICBcIk0wMDFcIixcbiAgICAgIFwiV29ya3RyZWUgUGF0aCBJbmplY3Rpb25cIixcbiAgICAgIFt7IGlkOiBcIlMwMVwiLCB0aXRsZTogXCJGaXJzdCBzbGljZVwiIH1dLFxuICAgICAgYmFzZSxcbiAgICApLFxuICAgIGJ1aWxkUmV3cml0ZURvY3NQcm9tcHQoXG4gICAgICBcIk0wMDFcIixcbiAgICAgIFwiV29ya3RyZWUgUGF0aCBJbmplY3Rpb25cIixcbiAgICAgIG51bGwsXG4gICAgICBiYXNlLFxuICAgICAgW3sgY2hhbmdlOiBcIlJlZnJlc2ggZG9jc1wiLCB0aW1lc3RhbXA6IFwiMjAyNi0wNC0yN1QwMDowMDowMC4wMDBaXCIsIGFwcGxpZWRBdDogXCJ0ZXN0XCIgfV0gYXMgYW55LFxuICAgICksXG4gIF0pO1xuXG4gIGFzc2VydC5vayhwcm9tcHRzWzBdLmluY2x1ZGVzKFwiIyMgQ29udGV4dCBNb2RlXCIpLCBcImRpc2N1c3MtbWlsZXN0b25lIHNob3VsZCBpbmNsdWRlIHN0YW5kYWxvbmUgQ29udGV4dCBNb2RlIGd1aWRhbmNlXCIpO1xuICBhc3NlcnQub2socHJvbXB0c1swXS5pbmNsdWRlcyhcImludGVydmlldyBsYW5lXCIpLCBcImRpc2N1c3MtbWlsZXN0b25lIHNob3VsZCByZW5kZXIgdGhlIGludGVydmlldyBsYW5lXCIpO1xuXG4gIGZvciAoY29uc3QgcHJvbXB0IG9mIHByb21wdHMpIHtcbiAgICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvd29ya2luZyBkaXJlY3RvcnkvaSk7XG4gICAgYXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcyhiYXNlKSwgXCJwcm9tcHQgc2hvdWxkIGluY2x1ZGUgdGhlIHByb3ZpZGVkIHdvcmtpbmcgZGlyZWN0b3J5XCIpO1xuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sUUFBUSxhQUFhO0FBQzVCLE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsYUFBYSxjQUFjLFFBQVEscUJBQXFCO0FBQzVFLFNBQVMsY0FBYztBQUN2QixTQUFTLFlBQVk7QUFFckIsTUFBTSxjQUFjLFFBQVEsSUFBSSwyQkFBMkI7QUFDM0QsTUFBTSxrQkFBa0IsUUFBUSxJQUFJO0FBQ3BDLE1BQU0scUJBQXFCLEtBQUssT0FBTyxHQUFHLGlCQUFpQixRQUFRLEdBQUcsSUFBSSxLQUFL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
