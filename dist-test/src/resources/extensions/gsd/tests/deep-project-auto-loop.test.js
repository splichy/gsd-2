import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runDispatch, runPreDispatch } from "../auto/phases.js";
import { AutoSession } from "../auto/session.js";
import { resolveUnitSupervisionTimeouts } from "../auto-timers.js";
import { bootstrapAutoSession } from "../auto-start.js";
import { postUnitPostVerification, postUnitPreVerification } from "../auto-post-unit.js";
import { resolveDispatch, setResearchProjectPromptBuilderForTest } from "../auto-dispatch.js";
import { resolveExpectedArtifactPath, verifyExpectedArtifact, writeBlockerPlaceholder } from "../auto-recovery.js";
import { finalizeProjectResearchTimeout } from "../project-research-policy.js";
import { resetRegistry } from "../rule-registry.js";
import { approvalGateIdForUnit, isAwaitingUserInput, isExplicitApprovalResponse, shouldPauseForUserApprovalQuestion } from "../user-input-boundary.js";
import {
  clearPendingAutoStart,
  checkDeepProjectSetupAfterTurn,
  clearPendingDeepProjectSetup,
  FOREGROUND_DEEP_SETUP_RULE_NAMES,
  showSmartEntry,
  startDeepProjectSetupForeground
} from "../guided-flow.js";
import {
  closeDatabase,
  insertMilestone,
  openDatabase
} from "../gsd-db.js";
function makeBase() {
  const base = join(tmpdir(), `gsd-deep-project-loop-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\n---\n");
  return base;
}
function makeCommandBase() {
  const base = join(tmpdir(), `gsd-deep-project-command-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  writeFileSync(join(base, "package.json"), '{"name":"gsd-command-test"}\n');
  return base;
}
function writeCommandGlobalDeepPrefs(base) {
  const home = join(base, ".test-gsd-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "PREFERENCES.md"),
    "---\nplanning_depth: deep\nlanguage: German\n---\n"
  );
}
function makeUnbornCommandRepo() {
  const base = join(tmpdir(), `gsd-deep-project-unborn-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  execFileSync("git", ["init"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: base });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: base });
  writeFileSync(join(base, "package.json"), '{"name":"gsd-unborn-command-test"}\n');
  return base;
}
function makeEmptyState() {
  return {
    phase: "pre-planning",
    activeMilestone: null,
    activeSlice: null,
    activeTask: null,
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: []
  };
}
function makeNeedsDiscussionState() {
  return {
    ...makeEmptyState(),
    phase: "needs-discussion",
    activeMilestone: { id: "M001", title: "Old light-mode milestone" },
    registry: [{ id: "M001", title: "Old light-mode milestone", status: "active" }]
  };
}
function makeExecutingState() {
  return {
    ...makeEmptyState(),
    phase: "executing",
    activeMilestone: { id: "M001", title: "Core App" },
    activeSlice: { id: "S01", title: "Storage layer" },
    activeTask: { id: "T01", title: "Build storage contract" },
    registry: [{ id: "M001", title: "Core App", status: "active" }]
  };
}
function makePlanningState() {
  return {
    ...makeEmptyState(),
    phase: "planning",
    activeMilestone: { id: "M001", title: "Core App" },
    activeSlice: { id: "S01", title: "Storage layer" },
    registry: [{ id: "M001", title: "Core App", status: "active" }]
  };
}
function writeCapturedDeepPrefs(base) {
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    "---\nplanning_depth: deep\nworkflow_prefs_captured: true\n---\n"
  );
}
function writeValidProjectAndRequirements(base) {
  const validProject = readFileSync(
    new URL("../schemas/__fixtures__/valid-project.md", import.meta.url),
    "utf-8"
  );
  const validRequirements = readFileSync(
    new URL("../schemas/__fixtures__/valid-requirements.md", import.meta.url),
    "utf-8"
  );
  writeFileSync(join(base, ".gsd", "PROJECT.md"), validProject);
  writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), validRequirements);
}
function makeRepo() {
  const base = makeBase();
  execFileSync("git", ["init"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: base });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: base });
  writeFileSync(join(base, "README.md"), "# test\n");
  execFileSync("git", ["add", "-A"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: base, stdio: "ignore" });
  return base;
}
function makeCtx(sessionId = "test-session") {
  const model = { provider: "claude-code", id: "claude-sonnet-4-6", contextWindow: 128e3 };
  return {
    ui: {
      notify: () => {
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
      getSessionId: () => sessionId,
      getSessionFile: () => null,
      getEntries: () => []
    }
  };
}
function makePi(messages) {
  let activeTools = [
    "ask_user_questions",
    "mcp__gsd-workflow__ask_user_questions",
    "read",
    "write",
    "edit",
    "bash",
    "gsd_summary_save"
  ];
  return {
    sendMessage: (message) => {
      messages.push(message);
    },
    getActiveTools: () => activeTools,
    setActiveTools: (tools) => {
      activeTools = tools;
    },
    setModel: async () => true,
    emitAdjustToolSet: async () => null,
    events: { emit: () => {
    } }
  };
}
async function runNewProjectCommand(base, command) {
  const previousCwd = process.cwd();
  const previousGsdHome = process.env.GSD_HOME;
  const previousWorkflowPath = process.env.GSD_WORKFLOW_PATH;
  const previousProjectRoot = process.env.GSD_PROJECT_ROOT;
  const workflowPath = join(base, "GSD-WORKFLOW.md");
  writeFileSync(workflowPath, "# Test Workflow\n");
  try {
    process.env.GSD_HOME = join(base, ".test-gsd-home");
    process.env.GSD_WORKFLOW_PATH = workflowPath;
    delete process.env.GSD_PROJECT_ROOT;
    process.chdir(base);
    const messages = [];
    const { handleWorkflowCommand } = await import("../commands/handlers/workflow.js");
    await handleWorkflowCommand(command, makeCtx(`command-${randomUUID()}`), makePi(messages));
    return messages;
  } finally {
    process.chdir(previousCwd);
    if (previousGsdHome === void 0) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousGsdHome;
    if (previousWorkflowPath === void 0) delete process.env.GSD_WORKFLOW_PATH;
    else process.env.GSD_WORKFLOW_PATH = previousWorkflowPath;
    if (previousProjectRoot === void 0) delete process.env.GSD_PROJECT_ROOT;
    else process.env.GSD_PROJECT_ROOT = previousProjectRoot;
    try {
      const { closeDatabase: closeDatabase2 } = await import("../gsd-db.js");
      closeDatabase2();
    } catch {
    }
  }
}
async function runBareGsdCommand(base) {
  const previousCwd = process.cwd();
  const previousGsdHome = process.env.GSD_HOME;
  const previousWorkflowPath = process.env.GSD_WORKFLOW_PATH;
  const previousProjectRoot = process.env.GSD_PROJECT_ROOT;
  const workflowPath = join(base, "GSD-WORKFLOW.md");
  writeFileSync(workflowPath, "# Test Workflow\n");
  try {
    process.env.GSD_HOME = join(base, ".test-gsd-home");
    process.env.GSD_WORKFLOW_PATH = workflowPath;
    delete process.env.GSD_PROJECT_ROOT;
    process.chdir(base);
    const messages = [];
    const { handleAutoCommand } = await import("../commands/handlers/auto.js");
    await handleAutoCommand("", makeCtx(`bare-${randomUUID()}`), makePi(messages));
    return messages;
  } finally {
    process.chdir(previousCwd);
    if (previousGsdHome === void 0) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousGsdHome;
    if (previousWorkflowPath === void 0) delete process.env.GSD_WORKFLOW_PATH;
    else process.env.GSD_WORKFLOW_PATH = previousWorkflowPath;
    if (previousProjectRoot === void 0) delete process.env.GSD_PROJECT_ROOT;
    else process.env.GSD_PROJECT_ROOT = previousProjectRoot;
    try {
      const { closeDatabase: closeDatabase2 } = await import("../gsd-db.js");
      closeDatabase2();
    } catch {
    }
  }
}
test("deep project setup: bootstrap can start auto-mode without an active milestone", async () => {
  const base = makeRepo();
  try {
    const s = new AutoSession();
    const ready = await bootstrapAutoSession(
      s,
      makeCtx(),
      {
        getThinkingLevel: () => "medium",
        getActiveTools: () => ["ask_user_questions", "read", "write", "edit", "bash"],
        events: { emit: () => {
        } }
      },
      base,
      false,
      false,
      {
        shouldUseWorktreeIsolation: () => false,
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
          }
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
    assert.equal(ready, true);
    assert.equal(s.active, true);
    assert.equal(s.currentMilestoneId, null);
  } finally {
    try {
      const { closeDatabase: closeDatabase2 } = await import("../gsd-db.js");
      closeDatabase2();
    } catch {
    }
    rmSync(base, { recursive: true, force: true });
  }
});
test("deep project setup: pre-dispatch can run before the first milestone exists", async () => {
  const base = makeBase();
  try {
    const s = new AutoSession();
    s.basePath = base;
    s.originalBasePath = base;
    s.resourceVersionOnStart = "test";
    let stopped = false;
    const deps = {
      checkResourcesStale: () => null,
      invalidateAllCaches: () => {
      },
      preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
      syncProjectRootToWorktree: () => {
      },
      deriveState: async () => makeEmptyState(),
      syncCmuxSidebar: () => {
      },
      stopAuto: async () => {
        stopped = true;
      },
      pauseAuto: async () => {
      },
      setActiveMilestoneId: () => {
      }
    };
    let seq = 0;
    const result = await runPreDispatch(
      {
        ctx: makeCtx(),
        pi: {},
        s,
        deps,
        prefs: { planning_depth: "deep" },
        iteration: 1,
        flowId: "test-flow",
        nextSeq: () => ++seq
      },
      { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 }
    );
    assert.equal(stopped, false);
    assert.equal(result.action, "next");
    if (result.action === "next") {
      assert.equal(result.data.mid, "PROJECT");
      assert.equal(result.data.midTitle, "Project setup");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("deep project setup: bootstrap continues queued M002 without milestone context", async () => {
  const base = makeRepo();
  try {
    writeCapturedDeepPrefs(base);
    writeValidProjectAndRequirements(base);
    mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
    writeFileSync(join(base, ".gsd", "runtime", "research-decision.json"), '{"decision":"skip"}\n');
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "First milestone", status: "complete" });
    insertMilestone({ id: "M002", title: "Second milestone", status: "queued" });
    closeDatabase();
    const messages = [];
    const pi = {
      ...makePi(messages),
      getThinkingLevel: () => "medium"
    };
    const s = new AutoSession();
    const ready = await bootstrapAutoSession(
      s,
      makeCtx(`queued-${randomUUID()}`),
      pi,
      base,
      false,
      false,
      {
        shouldUseWorktreeIsolation: () => false,
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
          }
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
    assert.equal(ready, true);
    assert.equal(s.active, true);
    assert.equal(s.currentMilestoneId, "M002");
    assert.equal(messages.length, 0, "queued deep milestone must not re-enter smart new-milestone discussion");
  } finally {
    try {
      closeDatabase();
    } catch {
    }
    rmSync(base, { recursive: true, force: true });
  }
});
test("deep project setup: pre-dispatch takes precedence over an existing draft milestone", async () => {
  const base = makeBase();
  try {
    const s = new AutoSession();
    s.basePath = base;
    s.originalBasePath = base;
    s.resourceVersionOnStart = "test";
    const deps = {
      checkResourcesStale: () => null,
      invalidateAllCaches: () => {
      },
      preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
      syncProjectRootToWorktree: () => {
      },
      deriveState: async () => makeNeedsDiscussionState(),
      syncCmuxSidebar: () => {
      },
      stopAuto: async () => {
      },
      pauseAuto: async () => {
      },
      setActiveMilestoneId: () => {
        throw new Error("must not activate milestone before deep project setup");
      }
    };
    let seq = 0;
    const result = await runPreDispatch(
      {
        ctx: makeCtx(),
        pi: {},
        s,
        deps,
        prefs: { planning_depth: "deep" },
        iteration: 1,
        flowId: "test-flow",
        nextSeq: () => ++seq
      },
      { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 }
    );
    assert.equal(result.action, "next");
    if (result.action === "next") {
      assert.equal(result.data.mid, "PROJECT");
      assert.equal(s.currentMilestoneId, null);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("deep project setup: pending setup does not rewrite executing state to PROJECT", async () => {
  const base = makeBase();
  try {
    const s = new AutoSession();
    s.basePath = base;
    s.originalBasePath = base;
    s.resourceVersionOnStart = "test";
    let paused = false;
    const deps = {
      checkResourcesStale: () => null,
      invalidateAllCaches: () => {
      },
      preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
      syncProjectRootToWorktree: () => {
      },
      deriveState: async () => makeExecutingState(),
      syncCmuxSidebar: () => {
      },
      stopAuto: async () => {
      },
      pauseAuto: async () => {
        paused = true;
      },
      setActiveMilestoneId: () => {
      },
      reconcileMergeState: () => "clean"
    };
    let seq = 0;
    const result = await runPreDispatch(
      {
        ctx: makeCtx(),
        pi: {},
        s,
        deps,
        prefs: { planning_depth: "deep", uok: { plan_v2: { enabled: false } } },
        iteration: 1,
        flowId: "test-flow",
        nextSeq: () => ++seq
      },
      { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 }
    );
    assert.equal(paused, false);
    assert.equal(result.action, "next");
    if (result.action === "next") {
      assert.equal(result.data.mid, "M001");
      assert.equal(result.data.state.phase, "executing");
      assert.equal(result.data.state.activeMilestone?.id, "M001");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("deep project setup: pre-dispatch does not rewrite execution state to PROJECT", async () => {
  const base = makeBase();
  try {
    writeCapturedDeepPrefs(base);
    writeValidProjectAndRequirements(base);
    mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
    writeFileSync(join(base, ".gsd", "runtime", "research-decision.json"), JSON.stringify({ decision: "skip" }));
    const s = new AutoSession();
    s.basePath = base;
    s.originalBasePath = base;
    s.resourceVersionOnStart = "test";
    let activeMilestoneId = null;
    const deps = {
      checkResourcesStale: () => null,
      invalidateAllCaches: () => {
      },
      preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
      syncProjectRootToWorktree: () => {
      },
      deriveState: async () => makeExecutingState(),
      syncCmuxSidebar: () => {
      },
      stopAuto: async () => {
      },
      pauseAuto: async () => {
      },
      setActiveMilestoneId: (_base, mid) => {
        activeMilestoneId = mid;
      },
      reconcileMergeState: () => "clean"
    };
    let seq = 0;
    const result = await runPreDispatch(
      {
        ctx: makeCtx(),
        pi: {},
        s,
        deps,
        prefs: { planning_depth: "deep", uok: { plan_v2: { enabled: false } } },
        iteration: 1,
        flowId: "test-flow",
        nextSeq: () => ++seq
      },
      { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 }
    );
    assert.equal(result.action, "next");
    if (result.action === "next") {
      assert.equal(result.data.mid, "M001");
      assert.equal(result.data.midTitle, "Core App");
      assert.equal(s.currentMilestoneId, "M001");
      assert.equal(activeMilestoneId, "M001");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("deep project setup: pending project research cannot dispatch PROJECT/S01", async (t) => {
  const base = makeBase();
  const restorePromptBuilder = setResearchProjectPromptBuilderForTest(async () => "research prompt");
  t.after(restorePromptBuilder);
  try {
    writeCapturedDeepPrefs(base);
    writeValidProjectAndRequirements(base);
    mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "runtime", "research-decision.json"),
      JSON.stringify({ decision: "research", source: "research-decision" })
    );
    const s = new AutoSession();
    s.basePath = base;
    s.originalBasePath = base;
    s.resourceVersionOnStart = "test";
    const deps = {
      checkResourcesStale: () => null,
      invalidateAllCaches: () => {
      },
      preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
      syncProjectRootToWorktree: () => {
      },
      deriveState: async () => makePlanningState(),
      syncCmuxSidebar: () => {
      },
      stopAuto: async () => {
      },
      pauseAuto: async () => {
      },
      setActiveMilestoneId: () => {
        throw new Error("must not activate milestone while project research is pending");
      }
    };
    let seq = 0;
    const result = await runPreDispatch(
      {
        ctx: makeCtx(),
        pi: {},
        s,
        deps,
        prefs: { planning_depth: "deep" },
        iteration: 1,
        flowId: "test-flow",
        nextSeq: () => ++seq
      },
      { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 }
    );
    assert.equal(result.action, "next");
    if (result.action !== "next") return;
    assert.equal(result.data.mid, "PROJECT");
    assert.equal(result.data.state.phase, "pre-planning");
    assert.equal(result.data.state.activeSlice, null);
    assert.equal(result.data.state.activeTask, null);
    resetRegistry();
    const dispatch = await resolveDispatch({
      basePath: base,
      mid: result.data.mid,
      midTitle: result.data.midTitle,
      state: result.data.state,
      prefs: { planning_depth: "deep" },
      structuredQuestionsAvailable: "false"
    });
    assert.equal(dispatch.action, "dispatch");
    if (dispatch.action === "dispatch") {
      assert.equal(dispatch.unitType, "research-project");
      assert.equal(dispatch.unitId, "RESEARCH-PROJECT");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("deep project setup: new-project command only writes planning_depth with --deep", async () => {
  const lightBase = makeCommandBase();
  const deepBase = makeCommandBase();
  try {
    writeCommandGlobalDeepPrefs(lightBase);
    const lightMessages = await runNewProjectCommand(lightBase, "new-project");
    const lightPrefsPath = join(lightBase, ".gsd", "PREFERENCES.md");
    if (existsSync(lightPrefsPath)) {
      assert.doesNotMatch(
        readFileSync(lightPrefsPath, "utf-8"),
        /planning_depth\s*:/,
        "plain /gsd new-project must not persist planning_depth"
      );
    }
    assert.equal(lightMessages.length, 1, "plain new-project should still dispatch the normal first milestone discussion");
    assert.doesNotMatch(
      String(lightMessages[0].content),
      /Foreground Deep Setup Question Policy/,
      "global planning_depth must not make plain new-project take the deep foreground setup path"
    );
    const deepMessages = await runNewProjectCommand(deepBase, "new-project --deep");
    const deepPrefs = readFileSync(join(deepBase, ".gsd", "PREFERENCES.md"), "utf-8");
    assert.match(deepPrefs, /planning_depth:\s*deep/);
    assert.match(deepPrefs, /workflow_prefs_captured:\s*true/);
    assert.equal(deepMessages.length, 1, "deep new-project should dispatch the foreground project setup interview");
    assert.match(String(deepMessages[0].content), /Foreground Deep Setup Question Policy/);
  } finally {
    clearPendingAutoStart(lightBase);
    clearPendingDeepProjectSetup(deepBase);
    rmSync(lightBase, { recursive: true, force: true });
    rmSync(deepBase, { recursive: true, force: true });
  }
});
test("deep project setup: bare /gsd ignores global planning_depth without project opt-in", async () => {
  const base = makeCommandBase();
  try {
    writeCommandGlobalDeepPrefs(base);
    const messages = await runBareGsdCommand(base);
    const prefsPath = join(base, ".gsd", "PREFERENCES.md");
    if (existsSync(prefsPath)) {
      assert.doesNotMatch(
        readFileSync(prefsPath, "utf-8"),
        /planning_depth\s*:/,
        "bare /gsd must not persist planning_depth from global preferences"
      );
    }
    assert.equal(messages.length, 1, "bare /gsd should dispatch the normal first milestone discussion");
    assert.doesNotMatch(
      String(messages[0].content),
      /Foreground Deep Setup Question Policy/,
      "global planning_depth must not make bare /gsd take the deep foreground setup path"
    );
  } finally {
    clearPendingAutoStart(base);
    clearPendingDeepProjectSetup(base);
    rmSync(base, { recursive: true, force: true });
  }
});
test("deep project setup: new-project --deep creates a reachable HEAD in unborn repos", async () => {
  const base = makeUnbornCommandRepo();
  try {
    const messages = await runNewProjectCommand(base, "new-project --deep");
    const subject = execFileSync("git", ["log", "-1", "--format=%s"], {
      cwd: base,
      encoding: "utf-8"
    }).trim();
    assert.equal(subject, "chore: init project");
    const deepPrefs = readFileSync(join(base, ".gsd", "PREFERENCES.md"), "utf-8");
    assert.match(deepPrefs, /planning_depth:\s*deep/);
    assert.equal(messages.length, 1, "deep new-project should still dispatch foreground setup");
    assert.match(String(messages[0].content), /Foreground Deep Setup Question Policy/);
  } finally {
    clearPendingDeepProjectSetup(base);
    rmSync(base, { recursive: true, force: true });
  }
});
test("deep project setup: new-project --deep uses cwd when nested inside a parent git repo", async () => {
  const parent = join(tmpdir(), `gsd-deep-project-parent-${randomUUID()}`);
  const child = join(parent, "nested-app");
  const previousCwd = process.cwd();
  const previousGsdHome = process.env.GSD_HOME;
  const previousWorkflowPath = process.env.GSD_WORKFLOW_PATH;
  const previousProjectRoot = process.env.GSD_PROJECT_ROOT;
  mkdirSync(child, { recursive: true });
  execFileSync("git", ["init"], { cwd: parent, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: parent });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: parent });
  writeFileSync(join(child, "package.json"), '{"name":"nested-app"}\n');
  writeFileSync(join(child, "GSD-WORKFLOW.md"), "# Test Workflow\n");
  try {
    process.env.GSD_HOME = join(child, ".test-gsd-home");
    process.env.GSD_WORKFLOW_PATH = join(child, "GSD-WORKFLOW.md");
    delete process.env.GSD_PROJECT_ROOT;
    process.chdir(child);
    const messages = [];
    const ctx = makeCtx(`nested-${randomUUID()}`);
    const pi = makePi(messages);
    const { handleWorkflowCommand } = await import("../commands/handlers/workflow.js");
    await handleWorkflowCommand("new-project --deep", ctx, pi);
    const childPrefs = readFileSync(join(child, ".gsd", "PREFERENCES.md"), "utf-8");
    assert.match(childPrefs, /planning_depth:\s*deep/);
    assert.equal(
      existsSync(join(parent, ".gsd", "PREFERENCES.md")),
      false,
      "new-project must not write deep prefs to the parent git root"
    );
    assert.equal(messages.length, 1);
    const validProject = readFileSync(
      new URL("../schemas/__fixtures__/valid-project.md", import.meta.url),
      "utf-8"
    );
    writeFileSync(join(child, ".gsd", "PROJECT.md"), validProject);
    const advanced = await checkDeepProjectSetupAfterTurn(
      { messages: [{ role: "assistant", content: "Project context written." }] },
      ctx,
      parent
    );
    assert.equal(advanced, true);
    assert.equal(messages.length, 2);
    assert.match(String(messages[1].content), /REQUIREMENTS\.md/);
  } finally {
    process.chdir(previousCwd);
    if (previousGsdHome === void 0) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousGsdHome;
    if (previousWorkflowPath === void 0) delete process.env.GSD_WORKFLOW_PATH;
    else process.env.GSD_WORKFLOW_PATH = previousWorkflowPath;
    if (previousProjectRoot === void 0) delete process.env.GSD_PROJECT_ROOT;
    else process.env.GSD_PROJECT_ROOT = previousProjectRoot;
    clearPendingDeepProjectSetup(child);
    rmSync(parent, { recursive: true, force: true });
    try {
      const { closeDatabase: closeDatabase2 } = await import("../gsd-db.js");
      closeDatabase2();
    } catch {
    }
  }
});
test("deep project setup: new-project asks interview stages in foreground", async () => {
  const base = makeBase();
  const previousWorkflowPath = process.env.GSD_WORKFLOW_PATH;
  process.env.GSD_WORKFLOW_PATH = join(base, "GSD-WORKFLOW.md");
  writeFileSync(process.env.GSD_WORKFLOW_PATH, "# Test Workflow\n");
  try {
    const messages = [];
    const ctx = makeCtx();
    const pi = makePi(messages);
    await startDeepProjectSetupForeground(ctx, pi, base, false);
    assert.equal(messages.length, 1);
    assert.match(
      messages[0].content,
      /What do you want to build\?/,
      "deep setup should ask the project question in the foreground conversation"
    );
    assert.match(
      messages[0].content,
      /Structured questions available:\s*false/,
      "foreground deep setup should force plain-chat questions even when question tools are active"
    );
    assert.match(
      messages[0].content,
      /Do NOT call `ask_user_questions`/,
      "foreground deep setup should explicitly forbid the cancellable question tool path"
    );
    const stillWaiting = await checkDeepProjectSetupAfterTurn(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "What do you want to build?" }]
          }
        ]
      },
      ctx
    );
    assert.equal(stillWaiting, false);
    assert.equal(messages.length, 1, "question turns without artifacts must not redispatch or auto-pause");
    const validProject = readFileSync(
      new URL("../schemas/__fixtures__/valid-project.md", import.meta.url),
      "utf-8"
    );
    writeFileSync(join(base, ".gsd", "PROJECT.md"), validProject);
    const advanced = await checkDeepProjectSetupAfterTurn(
      { messages: [{ role: "assistant", content: "Project captured." }] },
      ctx
    );
    assert.equal(advanced, true);
    assert.equal(messages.length, 2);
    assert.match(
      messages[1].content,
      /REQUIREMENTS\.md/,
      "after PROJECT.md exists, deep setup should foreground the requirements interview"
    );
    assert.match(
      messages[1].content,
      /Structured questions available:\s*false/,
      "requirements foreground setup should also force plain-chat questions"
    );
  } finally {
    clearPendingDeepProjectSetup(base);
    if (previousWorkflowPath === void 0) {
      delete process.env.GSD_WORKFLOW_PATH;
    } else {
      process.env.GSD_WORKFLOW_PATH = previousWorkflowPath;
    }
    rmSync(base, { recursive: true, force: true });
  }
});
test("deep auto dispatch forces milestone checkpoints into plain chat", async (t) => {
  const base = makeBase();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const s = new AutoSession();
  s.basePath = base;
  s.originalBasePath = base;
  let capturedStructured;
  const deps = {
    resolveDispatch: async (dispatchCtx) => {
      capturedStructured = dispatchCtx.structuredQuestionsAvailable;
      return {
        action: "dispatch",
        unitType: "discuss-milestone",
        unitId: "M001",
        prompt: `Structured questions available: ${dispatchCtx.structuredQuestionsAvailable}`,
        matchedRule: "test"
      };
    },
    emitJournalEvent: () => {
    },
    runPreDispatchHooks: () => ({ firedHooks: [], action: "proceed" }),
    getPriorSliceCompletionBlocker: () => null,
    getMainBranch: () => "main",
    invalidateAllCaches: () => {
    },
    stopAuto: async () => {
    },
    pauseAuto: async () => {
    }
  };
  const result = await runDispatch(
    {
      ctx: makeCtx(),
      pi: makePi([]),
      s,
      deps,
      prefs: { planning_depth: "deep" },
      iteration: 1,
      flowId: "flow-test",
      nextSeq: () => 1
    },
    {
      state: {
        phase: "pre-planning",
        activeMilestone: { id: "M001", title: "Plain Chat Gate" },
        activeSlice: null,
        activeTask: null,
        recentDecisions: [],
        blockers: [],
        nextAction: "",
        registry: []
      },
      mid: "M001",
      midTitle: "Plain Chat Gate"
    },
    {
      recentUnits: [],
      stuckRecoveryAttempts: 0,
      consecutiveFinalizeTimeouts: 0
    }
  );
  assert.equal(result.action, "next");
  assert.equal(capturedStructured, "false");
  if (result.action === "next") {
    assert.match(result.data.prompt, /Structured questions available: false/);
  }
});
test("deep project setup: unrelated agent_end sessions do not advance pending setup", async () => {
  const base = makeBase();
  const otherBase = makeBase();
  const previousWorkflowPath = process.env.GSD_WORKFLOW_PATH;
  process.env.GSD_WORKFLOW_PATH = join(base, "GSD-WORKFLOW.md");
  writeFileSync(process.env.GSD_WORKFLOW_PATH, "# Test Workflow\n");
  try {
    const messages = [];
    const deepCtx = makeCtx("deep-session");
    const otherCtx = makeCtx("other-session");
    const pi = makePi(messages);
    await startDeepProjectSetupForeground(deepCtx, pi, base, false);
    assert.equal(messages.length, 1);
    const validProject = readFileSync(
      new URL("../schemas/__fixtures__/valid-project.md", import.meta.url),
      "utf-8"
    );
    writeFileSync(join(base, ".gsd", "PROJECT.md"), validProject);
    const ignored = await checkDeepProjectSetupAfterTurn(
      { messages: [{ role: "assistant", content: "Unrelated light workflow completed." }] },
      otherCtx,
      otherBase
    );
    assert.equal(ignored, false);
    assert.equal(messages.length, 1, "unrelated session must not consume or advance pending deep setup");
    const advanced = await checkDeepProjectSetupAfterTurn(
      { messages: [{ role: "assistant", content: "Project captured." }] },
      deepCtx,
      base
    );
    assert.equal(advanced, true);
    assert.equal(messages.length, 2, "owning session should still advance pending deep setup");
  } finally {
    clearPendingDeepProjectSetup(base);
    if (previousWorkflowPath === void 0) {
      delete process.env.GSD_WORKFLOW_PATH;
    } else {
      process.env.GSD_WORKFLOW_PATH = previousWorkflowPath;
    }
    rmSync(base, { recursive: true, force: true });
    rmSync(otherBase, { recursive: true, force: true });
  }
});
test("deep project setup: same project advances when agent_end session id changes", async () => {
  const base = makeBase();
  const previousWorkflowPath = process.env.GSD_WORKFLOW_PATH;
  process.env.GSD_WORKFLOW_PATH = join(base, "GSD-WORKFLOW.md");
  writeFileSync(process.env.GSD_WORKFLOW_PATH, "# Test Workflow\n");
  try {
    const messages = [];
    const startCtx = makeCtx("start-session");
    const finishCtx = makeCtx("finish-session");
    const pi = makePi(messages);
    await startDeepProjectSetupForeground(startCtx, pi, base, false);
    assert.equal(messages.length, 1);
    const validProject = readFileSync(
      new URL("../schemas/__fixtures__/valid-project.md", import.meta.url),
      "utf-8"
    );
    writeFileSync(join(base, ".gsd", "PROJECT.md"), validProject);
    const advanced = await checkDeepProjectSetupAfterTurn(
      { messages: [{ role: "assistant", content: "Project captured." }] },
      finishCtx,
      base
    );
    assert.equal(advanced, true);
    assert.equal(messages.length, 2, "same project should advance even if the agent_end session id changed");
  } finally {
    clearPendingDeepProjectSetup(base);
    if (previousWorkflowPath === void 0) {
      delete process.env.GSD_WORKFLOW_PATH;
    } else {
      process.env.GSD_WORKFLOW_PATH = previousWorkflowPath;
    }
    rmSync(base, { recursive: true, force: true });
  }
});
test("deep project setup: foreground dispatcher does not probe research-project rule", () => {
  assert.equal(FOREGROUND_DEEP_SETUP_RULE_NAMES.has("deep: pre-planning (no PROJECT) \u2192 discuss-project"), true);
  assert.equal(FOREGROUND_DEEP_SETUP_RULE_NAMES.has("deep: pre-planning (no research decision) \u2192 research-decision"), true);
  assert.equal(FOREGROUND_DEEP_SETUP_RULE_NAMES.has("deep: pre-planning (no PROJECT research) \u2192 research-project"), false);
});
test("deep project setup: project-level units verify their real artifacts", () => {
  const base = makeBase();
  try {
    assert.equal(verifyExpectedArtifact("workflow-preferences", "WORKFLOW-PREFS", base), false);
    writeFileSync(
      join(base, ".gsd", "PREFERENCES.md"),
      "---\nplanning_depth: deep\nworkflow_prefs_captured: true\n---\n"
    );
    assert.equal(verifyExpectedArtifact("workflow-preferences", "WORKFLOW-PREFS", base), true);
    const validProject = readFileSync(
      new URL("../schemas/__fixtures__/valid-project.md", import.meta.url),
      "utf-8"
    );
    writeFileSync(join(base, ".gsd", "PROJECT.md"), validProject);
    assert.equal(verifyExpectedArtifact("discuss-project", "PROJECT", base), true);
    writeFileSync(join(base, ".gsd", "PROJECT.md"), "# Project\n");
    assert.equal(verifyExpectedArtifact("discuss-project", "PROJECT", base), false);
    const validRequirements = readFileSync(
      new URL("../schemas/__fixtures__/valid-requirements.md", import.meta.url),
      "utf-8"
    );
    writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), validRequirements);
    assert.equal(verifyExpectedArtifact("discuss-requirements", "REQUIREMENTS", base), true);
    mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
    writeFileSync(join(base, ".gsd", "runtime", "research-decision.json"), '{"decision":"maybe"}\n');
    assert.equal(verifyExpectedArtifact("research-decision", "RESEARCH-DECISION", base), false);
    writeFileSync(join(base, ".gsd", "runtime", "research-decision.json"), '{"decision":"skip"}\n');
    assert.equal(verifyExpectedArtifact("research-decision", "RESEARCH-DECISION", base), true);
    const researchDir = join(base, ".gsd", "research");
    mkdirSync(researchDir, { recursive: true });
    writeFileSync(join(researchDir, "STACK.md"), "# Stack\n");
    writeFileSync(join(researchDir, "FEATURES.md"), "# Features\n");
    writeFileSync(join(researchDir, "ARCHITECTURE.md"), "# Architecture\n");
    assert.equal(verifyExpectedArtifact("research-project", "PROJECT-RESEARCH", base), false);
    writeFileSync(join(researchDir, "PITFALLS-BLOCKER.md"), "# Blocked\n");
    assert.equal(verifyExpectedArtifact("research-project", "PROJECT-RESEARCH", base), true);
    for (const name of ["STACK.md", "FEATURES.md", "ARCHITECTURE.md"]) {
      rmSync(join(researchDir, name), { force: true });
    }
    for (const name of ["STACK", "FEATURES", "ARCHITECTURE"]) {
      writeFileSync(join(researchDir, `${name}-BLOCKER.md`), "# Blocked\n");
    }
    assert.equal(verifyExpectedArtifact("research-project", "PROJECT-RESEARCH", base), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("deep project setup: research-project blocker placeholder is a file, not the research directory", () => {
  const base = makeBase();
  try {
    const expectedPath = resolveExpectedArtifactPath("research-project", "PROJECT-RESEARCH", base);
    assert.equal(expectedPath, join(realpathSync(base), ".gsd", "research", "PROJECT-RESEARCH-BLOCKER.md"));
    mkdirSync(join(base, ".gsd", "research"), { recursive: true });
    const diagnosis = writeBlockerPlaceholder(
      "research-project",
      "PROJECT-RESEARCH",
      base,
      "test recovery"
    );
    assert.match(diagnosis ?? "", /research/i);
    assert.equal(existsSync(join(base, ".gsd", "research", "PROJECT-RESEARCH-BLOCKER.md")), true);
    assert.match(
      readFileSync(join(base, ".gsd", "research", "PROJECT-RESEARCH-BLOCKER.md"), "utf-8"),
      /fail-closed/
    );
    assert.equal(
      verifyExpectedArtifact("research-project", "PROJECT-RESEARCH", base),
      false,
      "project research blocker placeholders must not satisfy the research gate"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("deep project setup: research-project partial output writes dimension blockers instead of retrying", async () => {
  const base = makeBase();
  try {
    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "research-project", id: "RESEARCH-PROJECT", startedAt: Date.now() };
    mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
    writeFileSync(join(base, ".gsd", "runtime", "research-project-inflight"), "{}\n");
    mkdirSync(join(base, ".gsd", "research"), { recursive: true });
    writeFileSync(join(base, ".gsd", "research", "STACK.md"), "# Stack\n");
    const notifications = [];
    const result = await postUnitPreVerification(
      {
        s,
        ctx: { ui: { notify: (message) => notifications.push(message) } },
        pi: {},
        buildSnapshotOpts: () => ({}),
        lockBase: () => base,
        stopAuto: async () => {
        },
        pauseAuto: async () => {
        },
        updateProgressWidget: () => {
        }
      },
      { skipSettleDelay: true, skipWorktreeSync: true }
    );
    assert.equal(result, "continue");
    assert.equal(existsSync(join(base, ".gsd", "runtime", "research-project-inflight")), false);
    for (const name of ["FEATURES", "ARCHITECTURE", "PITFALLS"]) {
      assert.equal(existsSync(join(base, ".gsd", "research", `${name}-BLOCKER.md`)), true);
    }
    assert.equal(verifyExpectedArtifact("research-project", "RESEARCH-PROJECT", base), true);
    assert.equal(s.pendingVerificationRetry, null);
    assert.equal(s.verificationRetryCount.size, 0);
    assert.ok(
      notifications.some((message) => message.includes("without rerunning all scouts")),
      "should notify that partial research was finalized without another full fan-out"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("deep project setup: research-project empty output writes global blocker without retrying", async () => {
  const base = makeBase();
  try {
    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "research-project", id: "RESEARCH-PROJECT", startedAt: Date.now() };
    mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
    writeFileSync(join(base, ".gsd", "runtime", "research-project-inflight"), "{}\n");
    const notifications = [];
    const result = await postUnitPreVerification(
      {
        s,
        ctx: { ui: { notify: (message) => notifications.push(message) } },
        pi: {},
        buildSnapshotOpts: () => ({}),
        lockBase: () => base,
        stopAuto: async () => {
        },
        pauseAuto: async () => {
        },
        updateProgressWidget: () => {
        }
      },
      { skipSettleDelay: true, skipWorktreeSync: true }
    );
    assert.equal(result, "continue");
    assert.equal(existsSync(join(base, ".gsd", "runtime", "research-project-inflight")), false);
    assert.equal(existsSync(join(base, ".gsd", "research", "PROJECT-RESEARCH-BLOCKER.md")), true);
    assert.equal(verifyExpectedArtifact("research-project", "RESEARCH-PROJECT", base), false);
    assert.equal(s.pendingVerificationRetry, null);
    assert.equal(s.verificationRetryCount.size, 0);
    assert.ok(
      notifications.some((message) => message.includes("PROJECT-RESEARCH-BLOCKER.md")),
      "should notify that project research is fail-closed"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("deep project setup: project research timeout finalizer removes stale marker", () => {
  const base = makeBase();
  try {
    mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
    writeFileSync(join(base, ".gsd", "runtime", "research-project-inflight"), "{}\n");
    const outcome = finalizeProjectResearchTimeout(base, "test hard timeout");
    assert.equal(outcome.kind, "global-blocker");
    assert.equal(existsSync(join(base, ".gsd", "runtime", "research-project-inflight")), false);
    assert.equal(existsSync(join(base, ".gsd", "research", "PROJECT-RESEARCH-BLOCKER.md")), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("deep project setup: research-project supervision timeout is capped narrowly", () => {
  const defaults = {
    soft_timeout_minutes: 20,
    idle_timeout_minutes: 10,
    hard_timeout_minutes: 30
  };
  assert.deepEqual(
    resolveUnitSupervisionTimeouts("research-project", defaults, 1),
    {
      softTimeoutMs: 3 * 60 * 1e3,
      idleTimeoutMs: 10 * 60 * 1e3,
      hardTimeoutMs: 5 * 60 * 1e3
    }
  );
  assert.deepEqual(
    resolveUnitSupervisionTimeouts("research-project", {
      soft_timeout_minutes: 2,
      idle_timeout_minutes: 10,
      hard_timeout_minutes: 4
    }, 1),
    {
      softTimeoutMs: 2 * 60 * 1e3,
      idleTimeoutMs: 10 * 60 * 1e3,
      hardTimeoutMs: 4 * 60 * 1e3
    }
  );
  assert.deepEqual(
    resolveUnitSupervisionTimeouts("plan-slice", defaults, 2),
    {
      softTimeoutMs: 40 * 60 * 1e3,
      idleTimeoutMs: 10 * 60 * 1e3,
      hardTimeoutMs: 60 * 60 * 1e3
    }
  );
});
test("deep project setup: empty legacy pseudo-milestone dirs do not block first real milestone", async () => {
  const base = makeBase();
  const previousWorkflowPath = process.env.GSD_WORKFLOW_PATH;
  const workflowPath = join(base, "GSD-WORKFLOW.md");
  try {
    writeFileSync(workflowPath, "# Test Workflow\n");
    process.env.GSD_WORKFLOW_PATH = workflowPath;
    const validProject = readFileSync(
      new URL("../schemas/__fixtures__/valid-project.md", import.meta.url),
      "utf-8"
    );
    const validRequirements = readFileSync(
      new URL("../schemas/__fixtures__/valid-requirements.md", import.meta.url),
      "utf-8"
    );
    writeFileSync(
      join(base, ".gsd", "PREFERENCES.md"),
      "---\nplanning_depth: deep\nworkflow_prefs_captured: true\n---\n"
    );
    writeFileSync(join(base, ".gsd", "PROJECT.md"), validProject);
    writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), validRequirements);
    mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
    writeFileSync(join(base, ".gsd", "runtime", "research-decision.json"), '{"decision":"skip"}\n');
    for (const legacy of ["PROJECT", "RESEARCH-PROJECT", "WORKFLOW-PREFS"]) {
      mkdirSync(join(base, ".gsd", "milestones", legacy), { recursive: true });
    }
    const messages = [];
    await showSmartEntry(makeCtx(`legacy-${randomUUID()}`), makePi(messages), base);
    assert.equal(messages.length, 1, "first real milestone discussion should dispatch");
    assert.equal(existsSync(join(base, ".gsd", "milestones", "PROJECT")), false);
    assert.equal(existsSync(join(base, ".gsd", "milestones", "RESEARCH-PROJECT")), false);
    assert.equal(existsSync(join(base, ".gsd", "milestones", "WORKFLOW-PREFS")), false);
  } finally {
    if (previousWorkflowPath === void 0) delete process.env.GSD_WORKFLOW_PATH;
    else process.env.GSD_WORKFLOW_PATH = previousWorkflowPath;
    clearPendingAutoStart(base);
    try {
      const { closeDatabase: closeDatabase2 } = await import("../gsd-db.js");
      closeDatabase2();
    } catch {
    }
    rmSync(base, { recursive: true, force: true });
  }
});
test("deep project setup: project question pauses instead of artifact-retrying", async () => {
  const base = makeBase();
  try {
    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "discuss-project", id: "PROJECT", startedAt: Date.now() };
    let pauseCalled = false;
    const notifications = [];
    const result = await postUnitPreVerification(
      {
        s,
        ctx: { ui: { notify: (message) => notifications.push(message) } },
        pi: {},
        buildSnapshotOpts: () => ({}),
        lockBase: () => base,
        stopAuto: async () => {
        },
        pauseAuto: async () => {
          pauseCalled = true;
        },
        updateProgressWidget: () => {
        }
      },
      {
        skipSettleDelay: true,
        skipWorktreeSync: true,
        agentEndMessages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "What do you want to build?\n\nOptions:\n1. New app\n2. Existing app" }
            ]
          }
        ]
      }
    );
    assert.equal(result, "dispatched");
    assert.equal(pauseCalled, true);
    assert.equal(s.pendingVerificationRetry, null);
    assert.equal(s.verificationRetryCount.size, 0);
    assert.ok(
      notifications.some((message) => message.includes("waiting for your input")),
      "should notify that the project unit is waiting for user input"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("deep project setup: remote question failure is treated as waiting for user input", () => {
  assert.equal(
    isAwaitingUserInput([
      {
        role: "toolResult",
        content: "Remote questions failed (discord): Discord API HTTP 401"
      }
    ]),
    true
  );
});
test("deep project setup: user question does not masquerade as assistant input wait", () => {
  assert.equal(
    isAwaitingUserInput([
      {
        role: "user",
        content: "Should we proceed?"
      }
    ]),
    false
  );
});
test("deep project setup: user-quoted remote question failure does not pause auto-mode", () => {
  const messages = [
    {
      role: "user",
      content: "The log said: Remote questions failed (discord): Discord API HTTP 401"
    }
  ];
  assert.equal(isAwaitingUserInput(messages), false);
  assert.equal(shouldPauseForUserApprovalQuestion("discuss-project", messages), false);
});
test("deep project setup: plain-text approval wait is treated as waiting for user input", () => {
  assert.equal(
    isAwaitingUserInput([
      {
        role: "assistant",
        content: "Good, PROJECT.md confirms localStorage for persistence. Requirements look solid. Waiting for your confirmation before writing."
      }
    ]),
    true
  );
});
test("deep project setup: opening interview question does not trigger approval abort", () => {
  const messages = [
    {
      role: "assistant",
      content: "What do you want to build?"
    }
  ];
  assert.equal(isAwaitingUserInput(messages), true);
  assert.equal(shouldPauseForUserApprovalQuestion("discuss-project", messages), false);
});
test("deep project setup: grounding interview question with requirements context does not trigger approval abort", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        "I will use this to draft requirements.",
        "Grounding question: is this purely local/offline, or do you want tasks to persist across browser sessions/devices (local storage vs. a backend)?"
      ].join("\n")
    }
  ];
  assert.equal(isAwaitingUserInput(messages), true);
  assert.equal(shouldPauseForUserApprovalQuestion("discuss-project", messages), false);
});
test("deep project setup: persistence and anti-goals interview prompt does not trigger approval abort", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        "Greenfield, personal, plain HTML/CSS/JS, core value is create and check off tasks.",
        "",
        "A couple more:",
        "",
        "1. Persistence? Should tasks survive a page refresh (localStorage), or is it fine if they reset on reload?",
        "2. Anti-goals - what would you explicitly not want? (e.g., no user accounts, no backend, no categories/tags, no due dates - or something else)"
      ].join("\n")
    }
  ];
  assert.equal(isAwaitingUserInput(messages), true);
  assert.equal(shouldPauseForUserApprovalQuestion("discuss-project", messages), false);
});
test("deep project setup: discovery questions before writing PROJECT do not trigger approval abort", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        "Good. Greenfield HTML/CSS/JS to-do app, personal use, core feature is create and check off tasks.",
        "",
        "Two more questions before I write PROJECT.md:",
        "",
        "1. Any persistence? Should tasks survive a page refresh - localStorage, or is in-memory fine for now?",
        '2. Rough milestone shape? Is M001 "basic create/complete list that works in a browser," or do you have a v2 in mind (e.g., edit/delete, due dates, categories)?'
      ].join("\n")
    }
  ];
  assert.equal(isAwaitingUserInput(messages), true);
  assert.equal(shouldPauseForUserApprovalQuestion("discuss-project", messages), false);
});
test("deep project setup: discovery question mentioning write intent does not trigger approval abort", () => {
  const messages = [
    {
      role: "assistant",
      content: "Before I write PROJECT, any persistence?"
    }
  ];
  assert.equal(isAwaitingUserInput(messages), true);
  assert.equal(shouldPauseForUserApprovalQuestion("discuss-project", messages), false);
});
test("deep project setup: scope discovery question mentioning add does not trigger approval abort", () => {
  const messages = [
    {
      role: "assistant",
      content: "Should the basic milestone add delete support, or keep delete for a later v2?"
    }
  ];
  assert.equal(isAwaitingUserInput(messages), true);
  assert.equal(shouldPauseForUserApprovalQuestion("discuss-project", messages), false);
});
test("deep project setup: requirements preview question from screenshot is treated as waiting", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        "Proposed requirements:",
        "",
        "| ID | Title | Class | Status | Owner | Source |",
        "| --- | --- | --- | --- | --- | --- |",
        "| R001 | User can add a task | primary-user-loop | active | M001/none yet | user |",
        "",
        "Does this look right? Anything to add, remove, or reclassify?"
      ].join("\n")
    }
  ];
  assert.equal(isAwaitingUserInput(messages), true);
  assert.equal(shouldPauseForUserApprovalQuestion("discuss-requirements", messages), true);
});
test("deep project setup: research decision question triggers approval boundary pause", () => {
  assert.equal(
    shouldPauseForUserApprovalQuestion("research-decision", [
      {
        role: "assistant",
        content: "Run domain research now? (y/n)"
      }
    ]),
    true
  );
});
test("deep project setup: plain-text approval questions map to write-gate ids", () => {
  assert.equal(approvalGateIdForUnit("discuss-project", "PROJECT"), "depth_verification_project_confirm");
  assert.equal(approvalGateIdForUnit("discuss-requirements", "REQUIREMENTS"), "depth_verification_requirements_confirm");
  assert.equal(approvalGateIdForUnit("discuss-milestone", "M001"), "depth_verification_M001_confirm");
  assert.equal(approvalGateIdForUnit("research-decision", "RESEARCH-DECISION"), "depth_verification_research_decision_confirm");
});
test("deep project setup: plain-text approval gate clears only on explicit approval", () => {
  assert.equal(isExplicitApprovalResponse("yes, looks good"), true);
  assert.equal(isExplicitApprovalResponse("go ahead and write it"), true);
  assert.equal(isExplicitApprovalResponse("yes, add delete support first"), false);
  assert.equal(isExplicitApprovalResponse("not quite, remove the due date"), false);
  assert.equal(isExplicitApprovalResponse("research", "depth_verification_research_decision_confirm"), true);
});
test("deep project setup: discuss-milestone question failure pauses instead of artifact-retrying", async () => {
  const base = makeBase();
  try {
    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "discuss-milestone", id: "PROJECT", startedAt: Date.now() };
    let pauseCalled = false;
    const notifications = [];
    const result = await postUnitPreVerification(
      {
        s,
        ctx: { ui: { notify: (message) => notifications.push(message) } },
        pi: {},
        buildSnapshotOpts: () => ({}),
        lockBase: () => base,
        stopAuto: async () => {
        },
        pauseAuto: async () => {
          pauseCalled = true;
        },
        updateProgressWidget: () => {
        }
      },
      {
        skipSettleDelay: true,
        skipWorktreeSync: true,
        agentEndMessages: [
          {
            role: "toolResult",
            content: "Remote questions failed (discord): Discord API HTTP 401"
          }
        ]
      }
    );
    assert.equal(result, "dispatched");
    assert.equal(pauseCalled, true);
    assert.equal(s.pendingVerificationRetry, null);
    assert.equal(s.verificationRetryCount.size, 0);
    assert.ok(
      notifications.some((message) => message.includes("waiting for your input")),
      "should notify that the discuss unit is waiting for user input"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("verified task git closeout failure retries and continues auto-mode", async () => {
  const base = makeBase();
  try {
    execFileSync("git", ["init"], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: base, stdio: "ignore" });
    const hookPath = join(base, ".git", "hooks", "pre-commit");
    writeFileSync(
      hookPath,
      [
        "#!/bin/sh",
        "count_file=.git/pre-commit-count",
        "count=0",
        'if [ -f "$count_file" ]; then count=$(cat "$count_file"); fi',
        "count=$((count + 1))",
        'printf "%s" "$count" > "$count_file"',
        "echo blocked by test hook >&2",
        "exit 1"
      ].join("\n")
    );
    chmodSync(hookPath, 493);
    writeFileSync(join(base, "work.txt"), "changed\n");
    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.originalBasePath = base;
    s.currentUnit = { type: "execute-task", id: "M001/S01/T01", startedAt: Date.now() };
    let pauseCalled = false;
    const notifications = [];
    const result = await postUnitPostVerification({
      s,
      ctx: { ui: { notify: (message, severity) => notifications.push({ message, severity }) } },
      pi: {},
      buildSnapshotOpts: () => ({}),
      lockBase: () => base,
      stopAuto: async () => {
      },
      pauseAuto: async () => {
        pauseCalled = true;
      },
      updateProgressWidget: () => {
      }
    });
    assert.equal(result, "continue");
    assert.equal(pauseCalled, false);
    assert.equal(s.lastGitActionStatus, "failed");
    assert.equal(readFileSync(join(base, ".git", "pre-commit-count"), "utf-8"), "3");
    assert.ok(
      notifications.some((entry) => entry.severity === "warning" && entry.message.includes("Git commit failed")),
      "verified task git closeout failure should warn instead of stopping auto-mode"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("deep project setup: approval wait wins over deterministic write-gate placeholder", async () => {
  const base = makeBase();
  try {
    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "discuss-requirements", id: "REQUIREMENTS", startedAt: Date.now() };
    s.lastToolInvocationError = "gsd_summary_save: Error saving artifact: root_artifact_write_blocked";
    s.verificationRetryCount.set("discuss-requirements:REQUIREMENTS", 2);
    let pauseCalled = false;
    const notifications = [];
    const result = await postUnitPreVerification(
      {
        s,
        ctx: { ui: { notify: (message) => notifications.push(message) } },
        pi: {},
        buildSnapshotOpts: () => ({}),
        lockBase: () => base,
        stopAuto: async () => {
        },
        pauseAuto: async () => {
          pauseCalled = true;
        },
        updateProgressWidget: () => {
        }
      },
      {
        skipSettleDelay: true,
        skipWorktreeSync: true,
        agentEndMessages: [
          {
            role: "assistant",
            content: "Requirements look solid. Waiting for your confirmation before writing."
          }
        ]
      }
    );
    assert.equal(result, "dispatched");
    assert.equal(pauseCalled, true);
    assert.equal(s.lastToolInvocationError, null);
    assert.equal(existsSync(join(base, ".gsd", "REQUIREMENTS.md")), false);
    assert.ok(
      notifications.some((message) => message.includes("waiting for your input")),
      "should pause on the user wait instead of writing a blocker placeholder"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kZWVwLXByb2plY3QtYXV0by1sb29wLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgY2htb2RTeW5jLCBleGlzdHNTeW5jLCBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgcmVhbHBhdGhTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgZXhlY0ZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5cbmltcG9ydCB7IHJ1bkRpc3BhdGNoLCBydW5QcmVEaXNwYXRjaCB9IGZyb20gXCIuLi9hdXRvL3BoYXNlcy50c1wiO1xuaW1wb3J0IHsgQXV0b1Nlc3Npb24gfSBmcm9tIFwiLi4vYXV0by9zZXNzaW9uLnRzXCI7XG5pbXBvcnQgeyByZXNvbHZlVW5pdFN1cGVydmlzaW9uVGltZW91dHMgfSBmcm9tIFwiLi4vYXV0by10aW1lcnMudHNcIjtcbmltcG9ydCB7IGJvb3RzdHJhcEF1dG9TZXNzaW9uIH0gZnJvbSBcIi4uL2F1dG8tc3RhcnQudHNcIjtcbmltcG9ydCB7IHBvc3RVbml0UG9zdFZlcmlmaWNhdGlvbiwgcG9zdFVuaXRQcmVWZXJpZmljYXRpb24gfSBmcm9tIFwiLi4vYXV0by1wb3N0LXVuaXQudHNcIjtcbmltcG9ydCB7IHJlc29sdmVEaXNwYXRjaCwgc2V0UmVzZWFyY2hQcm9qZWN0UHJvbXB0QnVpbGRlckZvclRlc3QgfSBmcm9tIFwiLi4vYXV0by1kaXNwYXRjaC50c1wiO1xuaW1wb3J0IHsgcmVzb2x2ZUV4cGVjdGVkQXJ0aWZhY3RQYXRoLCB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0LCB3cml0ZUJsb2NrZXJQbGFjZWhvbGRlciB9IGZyb20gXCIuLi9hdXRvLXJlY292ZXJ5LnRzXCI7XG5pbXBvcnQgeyBmaW5hbGl6ZVByb2plY3RSZXNlYXJjaFRpbWVvdXQgfSBmcm9tIFwiLi4vcHJvamVjdC1yZXNlYXJjaC1wb2xpY3kudHNcIjtcbmltcG9ydCB7IHJlc2V0UmVnaXN0cnkgfSBmcm9tIFwiLi4vcnVsZS1yZWdpc3RyeS50c1wiO1xuaW1wb3J0IHsgYXBwcm92YWxHYXRlSWRGb3JVbml0LCBpc0F3YWl0aW5nVXNlcklucHV0LCBpc0V4cGxpY2l0QXBwcm92YWxSZXNwb25zZSwgc2hvdWxkUGF1c2VGb3JVc2VyQXBwcm92YWxRdWVzdGlvbiB9IGZyb20gXCIuLi91c2VyLWlucHV0LWJvdW5kYXJ5LnRzXCI7XG5pbXBvcnQge1xuICBjbGVhclBlbmRpbmdBdXRvU3RhcnQsXG4gIGNoZWNrRGVlcFByb2plY3RTZXR1cEFmdGVyVHVybixcbiAgY2xlYXJQZW5kaW5nRGVlcFByb2plY3RTZXR1cCxcbiAgRk9SRUdST1VORF9ERUVQX1NFVFVQX1JVTEVfTkFNRVMsXG4gIHNob3dTbWFydEVudHJ5LFxuICBzdGFydERlZXBQcm9qZWN0U2V0dXBGb3JlZ3JvdW5kLFxufSBmcm9tIFwiLi4vZ3VpZGVkLWZsb3cudHNcIjtcbmltcG9ydCB7XG4gIGNsb3NlRGF0YWJhc2UsXG4gIGluc2VydE1pbGVzdG9uZSxcbiAgb3BlbkRhdGFiYXNlLFxufSBmcm9tIFwiLi4vZ3NkLWRiLnRzXCI7XG5pbXBvcnQgdHlwZSB7IEdTRFByZWZlcmVuY2VzIH0gZnJvbSBcIi4uL3ByZWZlcmVuY2VzLnRzXCI7XG5pbXBvcnQgdHlwZSB7IEdTRFN0YXRlIH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5cbmZ1bmN0aW9uIG1ha2VCYXNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBqb2luKHRtcGRpcigpLCBgZ3NkLWRlZXAtcHJvamVjdC1sb29wLSR7cmFuZG9tVVVJRCgpfWApO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLCBcIi0tLVxcbnBsYW5uaW5nX2RlcHRoOiBkZWVwXFxuLS0tXFxuXCIpO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gbWFrZUNvbW1hbmRCYXNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBqb2luKHRtcGRpcigpLCBgZ3NkLWRlZXAtcHJvamVjdC1jb21tYW5kLSR7cmFuZG9tVVVJRCgpfWApO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwicGFja2FnZS5qc29uXCIpLCAne1wibmFtZVwiOlwiZ3NkLWNvbW1hbmQtdGVzdFwifVxcbicpO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gd3JpdGVDb21tYW5kR2xvYmFsRGVlcFByZWZzKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBob21lID0gam9pbihiYXNlLCBcIi50ZXN0LWdzZC1ob21lXCIpO1xuICBta2RpclN5bmMoaG9tZSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihob21lLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLFxuICAgIFwiLS0tXFxucGxhbm5pbmdfZGVwdGg6IGRlZXBcXG5sYW5ndWFnZTogR2VybWFuXFxuLS0tXFxuXCIsXG4gICk7XG59XG5cbmZ1bmN0aW9uIG1ha2VVbmJvcm5Db21tYW5kUmVwbygpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gam9pbih0bXBkaXIoKSwgYGdzZC1kZWVwLXByb2plY3QtdW5ib3JuLSR7cmFuZG9tVVVJRCgpfWApO1xuICBta2RpclN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJpbml0XCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJzeW1ib2xpYy1yZWZcIiwgXCJIRUFEXCIsIFwicmVmcy9oZWFkcy9tYWluXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjb25maWdcIiwgXCJ1c2VyLmVtYWlsXCIsIFwidGVzdEB0ZXN0LmNvbVwiXSwgeyBjd2Q6IGJhc2UgfSk7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjb25maWdcIiwgXCJ1c2VyLm5hbWVcIiwgXCJUZXN0XCJdLCB7IGN3ZDogYmFzZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwicGFja2FnZS5qc29uXCIpLCAne1wibmFtZVwiOlwiZ3NkLXVuYm9ybi1jb21tYW5kLXRlc3RcIn1cXG4nKTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIG1ha2VFbXB0eVN0YXRlKCk6IEdTRFN0YXRlIHtcbiAgcmV0dXJuIHtcbiAgICBwaGFzZTogXCJwcmUtcGxhbm5pbmdcIixcbiAgICBhY3RpdmVNaWxlc3RvbmU6IG51bGwsXG4gICAgYWN0aXZlU2xpY2U6IG51bGwsXG4gICAgYWN0aXZlVGFzazogbnVsbCxcbiAgICByZWNlbnREZWNpc2lvbnM6IFtdLFxuICAgIGJsb2NrZXJzOiBbXSxcbiAgICBuZXh0QWN0aW9uOiBcIlwiLFxuICAgIHJlZ2lzdHJ5OiBbXSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbWFrZU5lZWRzRGlzY3Vzc2lvblN0YXRlKCk6IEdTRFN0YXRlIHtcbiAgcmV0dXJuIHtcbiAgICAuLi5tYWtlRW1wdHlTdGF0ZSgpLFxuICAgIHBoYXNlOiBcIm5lZWRzLWRpc2N1c3Npb25cIixcbiAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJPbGQgbGlnaHQtbW9kZSBtaWxlc3RvbmVcIiB9LFxuICAgIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIk9sZCBsaWdodC1tb2RlIG1pbGVzdG9uZVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfV0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIG1ha2VFeGVjdXRpbmdTdGF0ZSgpOiBHU0RTdGF0ZSB7XG4gIHJldHVybiB7XG4gICAgLi4ubWFrZUVtcHR5U3RhdGUoKSxcbiAgICBwaGFzZTogXCJleGVjdXRpbmdcIixcbiAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJDb3JlIEFwcFwiIH0sXG4gICAgYWN0aXZlU2xpY2U6IHsgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIlN0b3JhZ2UgbGF5ZXJcIiB9LFxuICAgIGFjdGl2ZVRhc2s6IHsgaWQ6IFwiVDAxXCIsIHRpdGxlOiBcIkJ1aWxkIHN0b3JhZ2UgY29udHJhY3RcIiB9LFxuICAgIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIkNvcmUgQXBwXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9XSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbWFrZVBsYW5uaW5nU3RhdGUoKTogR1NEU3RhdGUge1xuICByZXR1cm4ge1xuICAgIC4uLm1ha2VFbXB0eVN0YXRlKCksXG4gICAgcGhhc2U6IFwicGxhbm5pbmdcIixcbiAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJDb3JlIEFwcFwiIH0sXG4gICAgYWN0aXZlU2xpY2U6IHsgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIlN0b3JhZ2UgbGF5ZXJcIiB9LFxuICAgIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIkNvcmUgQXBwXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9XSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gd3JpdGVDYXB0dXJlZERlZXBQcmVmcyhiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLFxuICAgIFwiLS0tXFxucGxhbm5pbmdfZGVwdGg6IGRlZXBcXG53b3JrZmxvd19wcmVmc19jYXB0dXJlZDogdHJ1ZVxcbi0tLVxcblwiLFxuICApO1xufVxuXG5mdW5jdGlvbiB3cml0ZVZhbGlkUHJvamVjdEFuZFJlcXVpcmVtZW50cyhiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgdmFsaWRQcm9qZWN0ID0gcmVhZEZpbGVTeW5jKFxuICAgIG5ldyBVUkwoXCIuLi9zY2hlbWFzL19fZml4dHVyZXNfXy92YWxpZC1wcm9qZWN0Lm1kXCIsIGltcG9ydC5tZXRhLnVybCksXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuICBjb25zdCB2YWxpZFJlcXVpcmVtZW50cyA9IHJlYWRGaWxlU3luYyhcbiAgICBuZXcgVVJMKFwiLi4vc2NoZW1hcy9fX2ZpeHR1cmVzX18vdmFsaWQtcmVxdWlyZW1lbnRzLm1kXCIsIGltcG9ydC5tZXRhLnVybCksXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUFJPSkVDVC5tZFwiKSwgdmFsaWRQcm9qZWN0KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlJFUVVJUkVNRU5UUy5tZFwiKSwgdmFsaWRSZXF1aXJlbWVudHMpO1xufVxuXG5mdW5jdGlvbiBtYWtlUmVwbygpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImluaXRcIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImNvbmZpZ1wiLCBcInVzZXIuZW1haWxcIiwgXCJ0ZXN0QHRlc3QuY29tXCJdLCB7IGN3ZDogYmFzZSB9KTtcbiAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImNvbmZpZ1wiLCBcInVzZXIubmFtZVwiLCBcIlRlc3RcIl0sIHsgY3dkOiBiYXNlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCJSRUFETUUubWRcIiksIFwiIyB0ZXN0XFxuXCIpO1xuICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiYWRkXCIsIFwiLUFcIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImNvbW1pdFwiLCBcIi1tXCIsIFwiaW5pdFwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gbWFrZUN0eChzZXNzaW9uSWQgPSBcInRlc3Qtc2Vzc2lvblwiKSB7XG4gIGNvbnN0IG1vZGVsID0geyBwcm92aWRlcjogXCJjbGF1ZGUtY29kZVwiLCBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCBjb250ZXh0V2luZG93OiAxMjgwMDAgfTtcbiAgcmV0dXJuIHtcbiAgICB1aToge1xuICAgICAgbm90aWZ5OiAoKSA9PiB7fSxcbiAgICAgIHNldFN0YXR1czogKCkgPT4ge30sXG4gICAgICBzZXRXaWRnZXQ6ICgpID0+IHt9LFxuICAgIH0sXG4gICAgbW9kZWwsXG4gICAgbW9kZWxSZWdpc3RyeToge1xuICAgICAgZ2V0QXZhaWxhYmxlOiAoKSA9PiBbbW9kZWxdLFxuICAgICAgaXNQcm92aWRlclJlcXVlc3RSZWFkeTogKCkgPT4gdHJ1ZSxcbiAgICAgIGdldFByb3ZpZGVyQXV0aE1vZGU6ICgpID0+IFwib2F1dGhcIixcbiAgICB9LFxuICAgIHNlc3Npb25NYW5hZ2VyOiB7XG4gICAgICBnZXRTZXNzaW9uSWQ6ICgpID0+IHNlc3Npb25JZCxcbiAgICAgIGdldFNlc3Npb25GaWxlOiAoKSA9PiBudWxsLFxuICAgICAgZ2V0RW50cmllczogKCkgPT4gW10sXG4gICAgfSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbWFrZVBpKG1lc3NhZ2VzOiB1bmtub3duW10pIHtcbiAgbGV0IGFjdGl2ZVRvb2xzID0gW1xuICAgIFwiYXNrX3VzZXJfcXVlc3Rpb25zXCIsXG4gICAgXCJtY3BfX2dzZC13b3JrZmxvd19fYXNrX3VzZXJfcXVlc3Rpb25zXCIsXG4gICAgXCJyZWFkXCIsXG4gICAgXCJ3cml0ZVwiLFxuICAgIFwiZWRpdFwiLFxuICAgIFwiYmFzaFwiLFxuICAgIFwiZ3NkX3N1bW1hcnlfc2F2ZVwiLFxuICBdO1xuICByZXR1cm4ge1xuICAgIHNlbmRNZXNzYWdlOiAobWVzc2FnZTogdW5rbm93bikgPT4ge1xuICAgICAgbWVzc2FnZXMucHVzaChtZXNzYWdlKTtcbiAgICB9LFxuICAgIGdldEFjdGl2ZVRvb2xzOiAoKSA9PiBhY3RpdmVUb29scyxcbiAgICBzZXRBY3RpdmVUb29sczogKHRvb2xzOiBzdHJpbmdbXSkgPT4ge1xuICAgICAgYWN0aXZlVG9vbHMgPSB0b29scztcbiAgICB9LFxuICAgIHNldE1vZGVsOiBhc3luYyAoKSA9PiB0cnVlLFxuICAgIGVtaXRBZGp1c3RUb29sU2V0OiBhc3luYyAoKSA9PiBudWxsLFxuICAgIGV2ZW50czogeyBlbWl0OiAoKSA9PiB7fSB9LFxuICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBydW5OZXdQcm9qZWN0Q29tbWFuZChiYXNlOiBzdHJpbmcsIGNvbW1hbmQ6IHN0cmluZyk6IFByb21pc2U8dW5rbm93bltdPiB7XG4gIGNvbnN0IHByZXZpb3VzQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3QgcHJldmlvdXNHc2RIb21lID0gcHJvY2Vzcy5lbnYuR1NEX0hPTUU7XG4gIGNvbnN0IHByZXZpb3VzV29ya2Zsb3dQYXRoID0gcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX1BBVEg7XG4gIGNvbnN0IHByZXZpb3VzUHJvamVjdFJvb3QgPSBwcm9jZXNzLmVudi5HU0RfUFJPSkVDVF9ST09UO1xuICBjb25zdCB3b3JrZmxvd1BhdGggPSBqb2luKGJhc2UsIFwiR1NELVdPUktGTE9XLm1kXCIpO1xuICB3cml0ZUZpbGVTeW5jKHdvcmtmbG93UGF0aCwgXCIjIFRlc3QgV29ya2Zsb3dcXG5cIik7XG5cbiAgdHJ5IHtcbiAgICBwcm9jZXNzLmVudi5HU0RfSE9NRSA9IGpvaW4oYmFzZSwgXCIudGVzdC1nc2QtaG9tZVwiKTtcbiAgICBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUEFUSCA9IHdvcmtmbG93UGF0aDtcbiAgICBkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX1BST0pFQ1RfUk9PVDtcbiAgICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gICAgY29uc3QgbWVzc2FnZXM6IHVua25vd25bXSA9IFtdO1xuICAgIGNvbnN0IHsgaGFuZGxlV29ya2Zsb3dDb21tYW5kIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9jb21tYW5kcy9oYW5kbGVycy93b3JrZmxvdy50c1wiKTtcbiAgICBhd2FpdCBoYW5kbGVXb3JrZmxvd0NvbW1hbmQoY29tbWFuZCwgbWFrZUN0eChgY29tbWFuZC0ke3JhbmRvbVVVSUQoKX1gKSBhcyBhbnksIG1ha2VQaShtZXNzYWdlcykgYXMgYW55KTtcbiAgICByZXR1cm4gbWVzc2FnZXM7XG4gIH0gZmluYWxseSB7XG4gICAgcHJvY2Vzcy5jaGRpcihwcmV2aW91c0N3ZCk7XG4gICAgaWYgKHByZXZpb3VzR3NkSG9tZSA9PT0gdW5kZWZpbmVkKSBkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX0hPTUU7XG4gICAgZWxzZSBwcm9jZXNzLmVudi5HU0RfSE9NRSA9IHByZXZpb3VzR3NkSG9tZTtcbiAgICBpZiAocHJldmlvdXNXb3JrZmxvd1BhdGggPT09IHVuZGVmaW5lZCkgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QQVRIO1xuICAgIGVsc2UgcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX1BBVEggPSBwcmV2aW91c1dvcmtmbG93UGF0aDtcbiAgICBpZiAocHJldmlvdXNQcm9qZWN0Um9vdCA9PT0gdW5kZWZpbmVkKSBkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX1BST0pFQ1RfUk9PVDtcbiAgICBlbHNlIHByb2Nlc3MuZW52LkdTRF9QUk9KRUNUX1JPT1QgPSBwcmV2aW91c1Byb2plY3RSb290O1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgY2xvc2VEYXRhYmFzZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vZ3NkLWRiLnRzXCIpO1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gY2F0Y2gge31cbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBydW5CYXJlR3NkQ29tbWFuZChiYXNlOiBzdHJpbmcpOiBQcm9taXNlPHVua25vd25bXT4ge1xuICBjb25zdCBwcmV2aW91c0N3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gIGNvbnN0IHByZXZpb3VzR3NkSG9tZSA9IHByb2Nlc3MuZW52LkdTRF9IT01FO1xuICBjb25zdCBwcmV2aW91c1dvcmtmbG93UGF0aCA9IHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QQVRIO1xuICBjb25zdCBwcmV2aW91c1Byb2plY3RSb290ID0gcHJvY2Vzcy5lbnYuR1NEX1BST0pFQ1RfUk9PVDtcbiAgY29uc3Qgd29ya2Zsb3dQYXRoID0gam9pbihiYXNlLCBcIkdTRC1XT1JLRkxPVy5tZFwiKTtcbiAgd3JpdGVGaWxlU3luYyh3b3JrZmxvd1BhdGgsIFwiIyBUZXN0IFdvcmtmbG93XFxuXCIpO1xuXG4gIHRyeSB7XG4gICAgcHJvY2Vzcy5lbnYuR1NEX0hPTUUgPSBqb2luKGJhc2UsIFwiLnRlc3QtZ3NkLWhvbWVcIik7XG4gICAgcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX1BBVEggPSB3b3JrZmxvd1BhdGg7XG4gICAgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9QUk9KRUNUX1JPT1Q7XG4gICAgcHJvY2Vzcy5jaGRpcihiYXNlKTtcblxuICAgIGNvbnN0IG1lc3NhZ2VzOiB1bmtub3duW10gPSBbXTtcbiAgICBjb25zdCB7IGhhbmRsZUF1dG9Db21tYW5kIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9jb21tYW5kcy9oYW5kbGVycy9hdXRvLnRzXCIpO1xuICAgIGF3YWl0IGhhbmRsZUF1dG9Db21tYW5kKFwiXCIsIG1ha2VDdHgoYGJhcmUtJHtyYW5kb21VVUlEKCl9YCkgYXMgYW55LCBtYWtlUGkobWVzc2FnZXMpIGFzIGFueSk7XG4gICAgcmV0dXJuIG1lc3NhZ2VzO1xuICB9IGZpbmFsbHkge1xuICAgIHByb2Nlc3MuY2hkaXIocHJldmlvdXNDd2QpO1xuICAgIGlmIChwcmV2aW91c0dzZEhvbWUgPT09IHVuZGVmaW5lZCkgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9IT01FO1xuICAgIGVsc2UgcHJvY2Vzcy5lbnYuR1NEX0hPTUUgPSBwcmV2aW91c0dzZEhvbWU7XG4gICAgaWYgKHByZXZpb3VzV29ya2Zsb3dQYXRoID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUEFUSDtcbiAgICBlbHNlIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QQVRIID0gcHJldmlvdXNXb3JrZmxvd1BhdGg7XG4gICAgaWYgKHByZXZpb3VzUHJvamVjdFJvb3QgPT09IHVuZGVmaW5lZCkgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9QUk9KRUNUX1JPT1Q7XG4gICAgZWxzZSBwcm9jZXNzLmVudi5HU0RfUFJPSkVDVF9ST09UID0gcHJldmlvdXNQcm9qZWN0Um9vdDtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IGNsb3NlRGF0YWJhc2UgfSA9IGF3YWl0IGltcG9ydChcIi4uL2dzZC1kYi50c1wiKTtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGNhdGNoIHt9XG4gIH1cbn1cblxudGVzdChcImRlZXAgcHJvamVjdCBzZXR1cDogYm9vdHN0cmFwIGNhbiBzdGFydCBhdXRvLW1vZGUgd2l0aG91dCBhbiBhY3RpdmUgbWlsZXN0b25lXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VSZXBvKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcyA9IG5ldyBBdXRvU2Vzc2lvbigpO1xuICAgIGNvbnN0IHJlYWR5ID0gYXdhaXQgYm9vdHN0cmFwQXV0b1Nlc3Npb24oXG4gICAgICBzLFxuICAgICAgbWFrZUN0eCgpIGFzIGFueSxcbiAgICAgIHtcbiAgICAgICAgZ2V0VGhpbmtpbmdMZXZlbDogKCkgPT4gXCJtZWRpdW1cIixcbiAgICAgICAgZ2V0QWN0aXZlVG9vbHM6ICgpID0+IFtcImFza191c2VyX3F1ZXN0aW9uc1wiLCBcInJlYWRcIiwgXCJ3cml0ZVwiLCBcImVkaXRcIiwgXCJiYXNoXCJdLFxuICAgICAgICBldmVudHM6IHsgZW1pdDogKCkgPT4ge30gfSxcbiAgICAgIH0gYXMgYW55LFxuICAgICAgYmFzZSxcbiAgICAgIGZhbHNlLFxuICAgICAgZmFsc2UsXG4gICAgICB7XG4gICAgICAgIHNob3VsZFVzZVdvcmt0cmVlSXNvbGF0aW9uOiAoKSA9PiBmYWxzZSxcbiAgICAgICAgcmVnaXN0ZXJTaWd0ZXJtSGFuZGxlcjogKCkgPT4ge30sXG4gICAgICAgIHJlZ2lzdGVyQXV0b1dvcmtlckZvclNlc3Npb246ICgpID0+IHt9LFxuICAgICAgICBsb2NrQmFzZTogKCkgPT4gYmFzZSxcbiAgICAgICAgYnVpbGRMaWZlY3ljbGU6ICgpID0+ICh7XG4gICAgICAgICAgYWRvcHRTZXNzaW9uUm9vdDogKHNlc3Npb25CYXNlOiBzdHJpbmcsIG9yaWdpbmFsQmFzZT86IHN0cmluZykgPT4ge1xuICAgICAgICAgICAgcy5iYXNlUGF0aCA9IHNlc3Npb25CYXNlO1xuICAgICAgICAgICAgaWYgKG9yaWdpbmFsQmFzZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICAgIHMub3JpZ2luYWxCYXNlUGF0aCA9IG9yaWdpbmFsQmFzZTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIXMub3JpZ2luYWxCYXNlUGF0aCkge1xuICAgICAgICAgICAgICBzLm9yaWdpbmFsQmFzZVBhdGggPSBzZXNzaW9uQmFzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9LFxuICAgICAgICB9KSBhcyBhbnksXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBjbGFzc2lmaWNhdGlvbjogXCJub25lXCIsXG4gICAgICAgIGxvY2s6IG51bGwsXG4gICAgICAgIHBhdXNlZFNlc3Npb246IG51bGwsXG4gICAgICAgIHN0YXRlOiBudWxsLFxuICAgICAgICByZWNvdmVyeTogbnVsbCxcbiAgICAgICAgcmVjb3ZlcnlQcm9tcHQ6IG51bGwsXG4gICAgICAgIHJlY292ZXJ5VG9vbENhbGxDb3VudDogMCxcbiAgICAgICAgYXJ0aWZhY3RTYXRpc2ZpZWQ6IGZhbHNlLFxuICAgICAgICBoYXNSZXN1bWFibGVEaXNrU3RhdGU6IGZhbHNlLFxuICAgICAgICBpc0Jvb3RzdHJhcENyYXNoOiBmYWxzZSxcbiAgICAgIH0sXG4gICAgKTtcblxuICAgIGFzc2VydC5lcXVhbChyZWFkeSwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHMuYWN0aXZlLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwocy5jdXJyZW50TWlsZXN0b25lSWQsIG51bGwpO1xuICB9IGZpbmFsbHkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IGNsb3NlRGF0YWJhc2UgfSA9IGF3YWl0IGltcG9ydChcIi4uL2dzZC1kYi50c1wiKTtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGNhdGNoIHt9XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZWVwIHByb2plY3Qgc2V0dXA6IHByZS1kaXNwYXRjaCBjYW4gcnVuIGJlZm9yZSB0aGUgZmlyc3QgbWlsZXN0b25lIGV4aXN0c1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICB0cnkge1xuICAgIGNvbnN0IHMgPSBuZXcgQXV0b1Nlc3Npb24oKTtcbiAgICBzLmJhc2VQYXRoID0gYmFzZTtcbiAgICBzLm9yaWdpbmFsQmFzZVBhdGggPSBiYXNlO1xuICAgIHMucmVzb3VyY2VWZXJzaW9uT25TdGFydCA9IFwidGVzdFwiO1xuXG4gICAgbGV0IHN0b3BwZWQgPSBmYWxzZTtcbiAgICBjb25zdCBkZXBzID0ge1xuICAgICAgY2hlY2tSZXNvdXJjZXNTdGFsZTogKCkgPT4gbnVsbCxcbiAgICAgIGludmFsaWRhdGVBbGxDYWNoZXM6ICgpID0+IHt9LFxuICAgICAgcHJlRGlzcGF0Y2hIZWFsdGhHYXRlOiBhc3luYyAoKSA9PiAoeyBwcm9jZWVkOiB0cnVlLCBmaXhlc0FwcGxpZWQ6IFtdIH0pLFxuICAgICAgc3luY1Byb2plY3RSb290VG9Xb3JrdHJlZTogKCkgPT4ge30sXG4gICAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4gbWFrZUVtcHR5U3RhdGUoKSxcbiAgICAgIHN5bmNDbXV4U2lkZWJhcjogKCkgPT4ge30sXG4gICAgICBzdG9wQXV0bzogYXN5bmMgKCkgPT4geyBzdG9wcGVkID0gdHJ1ZTsgfSxcbiAgICAgIHBhdXNlQXV0bzogYXN5bmMgKCkgPT4ge30sXG4gICAgICBzZXRBY3RpdmVNaWxlc3RvbmVJZDogKCkgPT4ge30sXG4gICAgfSBhcyBhbnk7XG5cbiAgICBsZXQgc2VxID0gMDtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5QcmVEaXNwYXRjaChcbiAgICAgIHtcbiAgICAgICAgY3R4OiBtYWtlQ3R4KCkgYXMgYW55LFxuICAgICAgICBwaToge30gYXMgYW55LFxuICAgICAgICBzLFxuICAgICAgICBkZXBzLFxuICAgICAgICBwcmVmczogeyBwbGFubmluZ19kZXB0aDogXCJkZWVwXCIgfSBhcyBHU0RQcmVmZXJlbmNlcyxcbiAgICAgICAgaXRlcmF0aW9uOiAxLFxuICAgICAgICBmbG93SWQ6IFwidGVzdC1mbG93XCIsXG4gICAgICAgIG5leHRTZXE6ICgpID0+ICsrc2VxLFxuICAgICAgfSxcbiAgICAgIHsgcmVjZW50VW5pdHM6IFtdLCBzdHVja1JlY292ZXJ5QXR0ZW1wdHM6IDAsIGNvbnNlY3V0aXZlRmluYWxpemVUaW1lb3V0czogMCB9LFxuICAgICk7XG5cbiAgICBhc3NlcnQuZXF1YWwoc3RvcHBlZCwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcIm5leHRcIik7XG4gICAgaWYgKHJlc3VsdC5hY3Rpb24gPT09IFwibmV4dFwiKSB7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRhdGEubWlkLCBcIlBST0pFQ1RcIik7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRhdGEubWlkVGl0bGUsIFwiUHJvamVjdCBzZXR1cFwiKTtcbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZWVwIHByb2plY3Qgc2V0dXA6IGJvb3RzdHJhcCBjb250aW51ZXMgcXVldWVkIE0wMDIgd2l0aG91dCBtaWxlc3RvbmUgY29udGV4dFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlUmVwbygpO1xuICB0cnkge1xuICAgIHdyaXRlQ2FwdHVyZWREZWVwUHJlZnMoYmFzZSk7XG4gICAgd3JpdGVWYWxpZFByb2plY3RBbmRSZXF1aXJlbWVudHMoYmFzZSk7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiwgXCJyZXNlYXJjaC1kZWNpc2lvbi5qc29uXCIpLCAne1wiZGVjaXNpb25cIjpcInNraXBcIn1cXG4nKTtcblxuICAgIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJGaXJzdCBtaWxlc3RvbmVcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIgfSk7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMlwiLCB0aXRsZTogXCJTZWNvbmQgbWlsZXN0b25lXCIsIHN0YXR1czogXCJxdWV1ZWRcIiB9KTtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG5cbiAgICBjb25zdCBtZXNzYWdlczogdW5rbm93bltdID0gW107XG4gICAgY29uc3QgcGkgPSB7XG4gICAgICAuLi5tYWtlUGkobWVzc2FnZXMpLFxuICAgICAgZ2V0VGhpbmtpbmdMZXZlbDogKCkgPT4gXCJtZWRpdW1cIixcbiAgICB9O1xuICAgIGNvbnN0IHMgPSBuZXcgQXV0b1Nlc3Npb24oKTtcbiAgICBjb25zdCByZWFkeSA9IGF3YWl0IGJvb3RzdHJhcEF1dG9TZXNzaW9uKFxuICAgICAgcyxcbiAgICAgIG1ha2VDdHgoYHF1ZXVlZC0ke3JhbmRvbVVVSUQoKX1gKSBhcyBhbnksXG4gICAgICBwaSBhcyBhbnksXG4gICAgICBiYXNlLFxuICAgICAgZmFsc2UsXG4gICAgICBmYWxzZSxcbiAgICAgIHtcbiAgICAgICAgc2hvdWxkVXNlV29ya3RyZWVJc29sYXRpb246ICgpID0+IGZhbHNlLFxuICAgICAgICByZWdpc3RlclNpZ3Rlcm1IYW5kbGVyOiAoKSA9PiB7fSxcbiAgICAgICAgcmVnaXN0ZXJBdXRvV29ya2VyRm9yU2Vzc2lvbjogKCkgPT4ge30sXG4gICAgICAgIGxvY2tCYXNlOiAoKSA9PiBiYXNlLFxuICAgICAgICBidWlsZExpZmVjeWNsZTogKCkgPT4gKHtcbiAgICAgICAgICBhZG9wdFNlc3Npb25Sb290OiAoc2Vzc2lvbkJhc2U6IHN0cmluZywgb3JpZ2luYWxCYXNlPzogc3RyaW5nKSA9PiB7XG4gICAgICAgICAgICBzLmJhc2VQYXRoID0gc2Vzc2lvbkJhc2U7XG4gICAgICAgICAgICBpZiAob3JpZ2luYWxCYXNlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgcy5vcmlnaW5hbEJhc2VQYXRoID0gb3JpZ2luYWxCYXNlO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghcy5vcmlnaW5hbEJhc2VQYXRoKSB7XG4gICAgICAgICAgICAgIHMub3JpZ2luYWxCYXNlUGF0aCA9IHNlc3Npb25CYXNlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0sXG4gICAgICAgIH0pIGFzIGFueSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGNsYXNzaWZpY2F0aW9uOiBcIm5vbmVcIixcbiAgICAgICAgbG9jazogbnVsbCxcbiAgICAgICAgcGF1c2VkU2Vzc2lvbjogbnVsbCxcbiAgICAgICAgc3RhdGU6IG51bGwsXG4gICAgICAgIHJlY292ZXJ5OiBudWxsLFxuICAgICAgICByZWNvdmVyeVByb21wdDogbnVsbCxcbiAgICAgICAgcmVjb3ZlcnlUb29sQ2FsbENvdW50OiAwLFxuICAgICAgICBhcnRpZmFjdFNhdGlzZmllZDogZmFsc2UsXG4gICAgICAgIGhhc1Jlc3VtYWJsZURpc2tTdGF0ZTogZmFsc2UsXG4gICAgICAgIGlzQm9vdHN0cmFwQ3Jhc2g6IGZhbHNlLFxuICAgICAgfSxcbiAgICApO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlYWR5LCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwocy5hY3RpdmUsIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChzLmN1cnJlbnRNaWxlc3RvbmVJZCwgXCJNMDAyXCIpO1xuICAgIGFzc2VydC5lcXVhbChtZXNzYWdlcy5sZW5ndGgsIDAsIFwicXVldWVkIGRlZXAgbWlsZXN0b25lIG11c3Qgbm90IHJlLWVudGVyIHNtYXJ0IG5ldy1taWxlc3RvbmUgZGlzY3Vzc2lvblwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICB0cnkgeyBjbG9zZURhdGFiYXNlKCk7IH0gY2F0Y2gge31cbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcImRlZXAgcHJvamVjdCBzZXR1cDogcHJlLWRpc3BhdGNoIHRha2VzIHByZWNlZGVuY2Ugb3ZlciBhbiBleGlzdGluZyBkcmFmdCBtaWxlc3RvbmVcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBzID0gbmV3IEF1dG9TZXNzaW9uKCk7XG4gICAgcy5iYXNlUGF0aCA9IGJhc2U7XG4gICAgcy5vcmlnaW5hbEJhc2VQYXRoID0gYmFzZTtcbiAgICBzLnJlc291cmNlVmVyc2lvbk9uU3RhcnQgPSBcInRlc3RcIjtcblxuICAgIGNvbnN0IGRlcHMgPSB7XG4gICAgICBjaGVja1Jlc291cmNlc1N0YWxlOiAoKSA9PiBudWxsLFxuICAgICAgaW52YWxpZGF0ZUFsbENhY2hlczogKCkgPT4ge30sXG4gICAgICBwcmVEaXNwYXRjaEhlYWx0aEdhdGU6IGFzeW5jICgpID0+ICh7IHByb2NlZWQ6IHRydWUsIGZpeGVzQXBwbGllZDogW10gfSksXG4gICAgICBzeW5jUHJvamVjdFJvb3RUb1dvcmt0cmVlOiAoKSA9PiB7fSxcbiAgICAgIGRlcml2ZVN0YXRlOiBhc3luYyAoKSA9PiBtYWtlTmVlZHNEaXNjdXNzaW9uU3RhdGUoKSxcbiAgICAgIHN5bmNDbXV4U2lkZWJhcjogKCkgPT4ge30sXG4gICAgICBzdG9wQXV0bzogYXN5bmMgKCkgPT4ge30sXG4gICAgICBwYXVzZUF1dG86IGFzeW5jICgpID0+IHt9LFxuICAgICAgc2V0QWN0aXZlTWlsZXN0b25lSWQ6ICgpID0+IHsgdGhyb3cgbmV3IEVycm9yKFwibXVzdCBub3QgYWN0aXZhdGUgbWlsZXN0b25lIGJlZm9yZSBkZWVwIHByb2plY3Qgc2V0dXBcIik7IH0sXG4gICAgfSBhcyBhbnk7XG5cbiAgICBsZXQgc2VxID0gMDtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5QcmVEaXNwYXRjaChcbiAgICAgIHtcbiAgICAgICAgY3R4OiBtYWtlQ3R4KCkgYXMgYW55LFxuICAgICAgICBwaToge30gYXMgYW55LFxuICAgICAgICBzLFxuICAgICAgICBkZXBzLFxuICAgICAgICBwcmVmczogeyBwbGFubmluZ19kZXB0aDogXCJkZWVwXCIgfSBhcyBHU0RQcmVmZXJlbmNlcyxcbiAgICAgICAgaXRlcmF0aW9uOiAxLFxuICAgICAgICBmbG93SWQ6IFwidGVzdC1mbG93XCIsXG4gICAgICAgIG5leHRTZXE6ICgpID0+ICsrc2VxLFxuICAgICAgfSxcbiAgICAgIHsgcmVjZW50VW5pdHM6IFtdLCBzdHVja1JlY292ZXJ5QXR0ZW1wdHM6IDAsIGNvbnNlY3V0aXZlRmluYWxpemVUaW1lb3V0czogMCB9LFxuICAgICk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmFjdGlvbiwgXCJuZXh0XCIpO1xuICAgIGlmIChyZXN1bHQuYWN0aW9uID09PSBcIm5leHRcIikge1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kYXRhLm1pZCwgXCJQUk9KRUNUXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHMuY3VycmVudE1pbGVzdG9uZUlkLCBudWxsKTtcbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZWVwIHByb2plY3Qgc2V0dXA6IHBlbmRpbmcgc2V0dXAgZG9lcyBub3QgcmV3cml0ZSBleGVjdXRpbmcgc3RhdGUgdG8gUFJPSkVDVFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICB0cnkge1xuICAgIGNvbnN0IHMgPSBuZXcgQXV0b1Nlc3Npb24oKTtcbiAgICBzLmJhc2VQYXRoID0gYmFzZTtcbiAgICBzLm9yaWdpbmFsQmFzZVBhdGggPSBiYXNlO1xuICAgIHMucmVzb3VyY2VWZXJzaW9uT25TdGFydCA9IFwidGVzdFwiO1xuXG4gICAgbGV0IHBhdXNlZCA9IGZhbHNlO1xuICAgIGNvbnN0IGRlcHMgPSB7XG4gICAgICBjaGVja1Jlc291cmNlc1N0YWxlOiAoKSA9PiBudWxsLFxuICAgICAgaW52YWxpZGF0ZUFsbENhY2hlczogKCkgPT4ge30sXG4gICAgICBwcmVEaXNwYXRjaEhlYWx0aEdhdGU6IGFzeW5jICgpID0+ICh7IHByb2NlZWQ6IHRydWUsIGZpeGVzQXBwbGllZDogW10gfSksXG4gICAgICBzeW5jUHJvamVjdFJvb3RUb1dvcmt0cmVlOiAoKSA9PiB7fSxcbiAgICAgIGRlcml2ZVN0YXRlOiBhc3luYyAoKSA9PiBtYWtlRXhlY3V0aW5nU3RhdGUoKSxcbiAgICAgIHN5bmNDbXV4U2lkZWJhcjogKCkgPT4ge30sXG4gICAgICBzdG9wQXV0bzogYXN5bmMgKCkgPT4ge30sXG4gICAgICBwYXVzZUF1dG86IGFzeW5jICgpID0+IHsgcGF1c2VkID0gdHJ1ZTsgfSxcbiAgICAgIHNldEFjdGl2ZU1pbGVzdG9uZUlkOiAoKSA9PiB7fSxcbiAgICAgIHJlY29uY2lsZU1lcmdlU3RhdGU6ICgpID0+IFwiY2xlYW5cIixcbiAgICB9IGFzIGFueTtcblxuICAgIGxldCBzZXEgPSAwO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blByZURpc3BhdGNoKFxuICAgICAge1xuICAgICAgICBjdHg6IG1ha2VDdHgoKSBhcyBhbnksXG4gICAgICAgIHBpOiB7fSBhcyBhbnksXG4gICAgICAgIHMsXG4gICAgICAgIGRlcHMsXG4gICAgICAgIHByZWZzOiB7IHBsYW5uaW5nX2RlcHRoOiBcImRlZXBcIiwgdW9rOiB7IHBsYW5fdjI6IHsgZW5hYmxlZDogZmFsc2UgfSB9IH0gYXMgR1NEUHJlZmVyZW5jZXMsXG4gICAgICAgIGl0ZXJhdGlvbjogMSxcbiAgICAgICAgZmxvd0lkOiBcInRlc3QtZmxvd1wiLFxuICAgICAgICBuZXh0U2VxOiAoKSA9PiArK3NlcSxcbiAgICAgIH0sXG4gICAgICB7IHJlY2VudFVuaXRzOiBbXSwgc3R1Y2tSZWNvdmVyeUF0dGVtcHRzOiAwLCBjb25zZWN1dGl2ZUZpbmFsaXplVGltZW91dHM6IDAgfSxcbiAgICApO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHBhdXNlZCwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcIm5leHRcIik7XG4gICAgaWYgKHJlc3VsdC5hY3Rpb24gPT09IFwibmV4dFwiKSB7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRhdGEubWlkLCBcIk0wMDFcIik7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRhdGEuc3RhdGUucGhhc2UsIFwiZXhlY3V0aW5nXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kYXRhLnN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsIFwiTTAwMVwiKTtcbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZWVwIHByb2plY3Qgc2V0dXA6IHByZS1kaXNwYXRjaCBkb2VzIG5vdCByZXdyaXRlIGV4ZWN1dGlvbiBzdGF0ZSB0byBQUk9KRUNUXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVDYXB0dXJlZERlZXBQcmVmcyhiYXNlKTtcbiAgICB3cml0ZVZhbGlkUHJvamVjdEFuZFJlcXVpcmVtZW50cyhiYXNlKTtcbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiLCBcInJlc2VhcmNoLWRlY2lzaW9uLmpzb25cIiksIEpTT04uc3RyaW5naWZ5KHsgZGVjaXNpb246IFwic2tpcFwiIH0pKTtcblxuICAgIGNvbnN0IHMgPSBuZXcgQXV0b1Nlc3Npb24oKTtcbiAgICBzLmJhc2VQYXRoID0gYmFzZTtcbiAgICBzLm9yaWdpbmFsQmFzZVBhdGggPSBiYXNlO1xuICAgIHMucmVzb3VyY2VWZXJzaW9uT25TdGFydCA9IFwidGVzdFwiO1xuXG4gICAgbGV0IGFjdGl2ZU1pbGVzdG9uZUlkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBjb25zdCBkZXBzID0ge1xuICAgICAgY2hlY2tSZXNvdXJjZXNTdGFsZTogKCkgPT4gbnVsbCxcbiAgICAgIGludmFsaWRhdGVBbGxDYWNoZXM6ICgpID0+IHt9LFxuICAgICAgcHJlRGlzcGF0Y2hIZWFsdGhHYXRlOiBhc3luYyAoKSA9PiAoeyBwcm9jZWVkOiB0cnVlLCBmaXhlc0FwcGxpZWQ6IFtdIH0pLFxuICAgICAgc3luY1Byb2plY3RSb290VG9Xb3JrdHJlZTogKCkgPT4ge30sXG4gICAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4gbWFrZUV4ZWN1dGluZ1N0YXRlKCksXG4gICAgICBzeW5jQ211eFNpZGViYXI6ICgpID0+IHt9LFxuICAgICAgc3RvcEF1dG86IGFzeW5jICgpID0+IHt9LFxuICAgICAgcGF1c2VBdXRvOiBhc3luYyAoKSA9PiB7fSxcbiAgICAgIHNldEFjdGl2ZU1pbGVzdG9uZUlkOiAoX2Jhc2U6IHN0cmluZywgbWlkOiBzdHJpbmcpID0+IHsgYWN0aXZlTWlsZXN0b25lSWQgPSBtaWQ7IH0sXG4gICAgICByZWNvbmNpbGVNZXJnZVN0YXRlOiAoKSA9PiBcImNsZWFuXCIsXG4gICAgfSBhcyBhbnk7XG5cbiAgICBsZXQgc2VxID0gMDtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5QcmVEaXNwYXRjaChcbiAgICAgIHtcbiAgICAgICAgY3R4OiBtYWtlQ3R4KCkgYXMgYW55LFxuICAgICAgICBwaToge30gYXMgYW55LFxuICAgICAgICBzLFxuICAgICAgICBkZXBzLFxuICAgICAgICBwcmVmczogeyBwbGFubmluZ19kZXB0aDogXCJkZWVwXCIsIHVvazogeyBwbGFuX3YyOiB7IGVuYWJsZWQ6IGZhbHNlIH0gfSB9IGFzIEdTRFByZWZlcmVuY2VzLFxuICAgICAgICBpdGVyYXRpb246IDEsXG4gICAgICAgIGZsb3dJZDogXCJ0ZXN0LWZsb3dcIixcbiAgICAgICAgbmV4dFNlcTogKCkgPT4gKytzZXEsXG4gICAgICB9LFxuICAgICAgeyByZWNlbnRVbml0czogW10sIHN0dWNrUmVjb3ZlcnlBdHRlbXB0czogMCwgY29uc2VjdXRpdmVGaW5hbGl6ZVRpbWVvdXRzOiAwIH0sXG4gICAgKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcIm5leHRcIik7XG4gICAgaWYgKHJlc3VsdC5hY3Rpb24gPT09IFwibmV4dFwiKSB7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRhdGEubWlkLCBcIk0wMDFcIik7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRhdGEubWlkVGl0bGUsIFwiQ29yZSBBcHBcIik7XG4gICAgICBhc3NlcnQuZXF1YWwocy5jdXJyZW50TWlsZXN0b25lSWQsIFwiTTAwMVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChhY3RpdmVNaWxlc3RvbmVJZCwgXCJNMDAxXCIpO1xuICAgIH1cbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcImRlZXAgcHJvamVjdCBzZXR1cDogcGVuZGluZyBwcm9qZWN0IHJlc2VhcmNoIGNhbm5vdCBkaXNwYXRjaCBQUk9KRUNUL1MwMVwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgY29uc3QgcmVzdG9yZVByb21wdEJ1aWxkZXIgPSBzZXRSZXNlYXJjaFByb2plY3RQcm9tcHRCdWlsZGVyRm9yVGVzdChhc3luYyAoKSA9PiBcInJlc2VhcmNoIHByb21wdFwiKTtcbiAgdC5hZnRlcihyZXN0b3JlUHJvbXB0QnVpbGRlcik7XG5cbiAgdHJ5IHtcbiAgICB3cml0ZUNhcHR1cmVkRGVlcFByZWZzKGJhc2UpO1xuICAgIHdyaXRlVmFsaWRQcm9qZWN0QW5kUmVxdWlyZW1lbnRzKGJhc2UpO1xuICAgIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiwgXCJyZXNlYXJjaC1kZWNpc2lvbi5qc29uXCIpLFxuICAgICAgSlNPTi5zdHJpbmdpZnkoeyBkZWNpc2lvbjogXCJyZXNlYXJjaFwiLCBzb3VyY2U6IFwicmVzZWFyY2gtZGVjaXNpb25cIiB9KSxcbiAgICApO1xuXG4gICAgY29uc3QgcyA9IG5ldyBBdXRvU2Vzc2lvbigpO1xuICAgIHMuYmFzZVBhdGggPSBiYXNlO1xuICAgIHMub3JpZ2luYWxCYXNlUGF0aCA9IGJhc2U7XG4gICAgcy5yZXNvdXJjZVZlcnNpb25PblN0YXJ0ID0gXCJ0ZXN0XCI7XG5cbiAgICBjb25zdCBkZXBzID0ge1xuICAgICAgY2hlY2tSZXNvdXJjZXNTdGFsZTogKCkgPT4gbnVsbCxcbiAgICAgIGludmFsaWRhdGVBbGxDYWNoZXM6ICgpID0+IHt9LFxuICAgICAgcHJlRGlzcGF0Y2hIZWFsdGhHYXRlOiBhc3luYyAoKSA9PiAoeyBwcm9jZWVkOiB0cnVlLCBmaXhlc0FwcGxpZWQ6IFtdIH0pLFxuICAgICAgc3luY1Byb2plY3RSb290VG9Xb3JrdHJlZTogKCkgPT4ge30sXG4gICAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4gbWFrZVBsYW5uaW5nU3RhdGUoKSxcbiAgICAgIHN5bmNDbXV4U2lkZWJhcjogKCkgPT4ge30sXG4gICAgICBzdG9wQXV0bzogYXN5bmMgKCkgPT4ge30sXG4gICAgICBwYXVzZUF1dG86IGFzeW5jICgpID0+IHt9LFxuICAgICAgc2V0QWN0aXZlTWlsZXN0b25lSWQ6ICgpID0+IHsgdGhyb3cgbmV3IEVycm9yKFwibXVzdCBub3QgYWN0aXZhdGUgbWlsZXN0b25lIHdoaWxlIHByb2plY3QgcmVzZWFyY2ggaXMgcGVuZGluZ1wiKTsgfSxcbiAgICB9IGFzIGFueTtcblxuICAgIGxldCBzZXEgPSAwO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blByZURpc3BhdGNoKFxuICAgICAge1xuICAgICAgICBjdHg6IG1ha2VDdHgoKSBhcyBhbnksXG4gICAgICAgIHBpOiB7fSBhcyBhbnksXG4gICAgICAgIHMsXG4gICAgICAgIGRlcHMsXG4gICAgICAgIHByZWZzOiB7IHBsYW5uaW5nX2RlcHRoOiBcImRlZXBcIiB9IGFzIEdTRFByZWZlcmVuY2VzLFxuICAgICAgICBpdGVyYXRpb246IDEsXG4gICAgICAgIGZsb3dJZDogXCJ0ZXN0LWZsb3dcIixcbiAgICAgICAgbmV4dFNlcTogKCkgPT4gKytzZXEsXG4gICAgICB9LFxuICAgICAgeyByZWNlbnRVbml0czogW10sIHN0dWNrUmVjb3ZlcnlBdHRlbXB0czogMCwgY29uc2VjdXRpdmVGaW5hbGl6ZVRpbWVvdXRzOiAwIH0sXG4gICAgKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcIm5leHRcIik7XG4gICAgaWYgKHJlc3VsdC5hY3Rpb24gIT09IFwibmV4dFwiKSByZXR1cm47XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRhdGEubWlkLCBcIlBST0pFQ1RcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kYXRhLnN0YXRlLnBoYXNlLCBcInByZS1wbGFubmluZ1wiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRhdGEuc3RhdGUuYWN0aXZlU2xpY2UsIG51bGwpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZGF0YS5zdGF0ZS5hY3RpdmVUYXNrLCBudWxsKTtcblxuICAgIHJlc2V0UmVnaXN0cnkoKTtcbiAgICBjb25zdCBkaXNwYXRjaCA9IGF3YWl0IHJlc29sdmVEaXNwYXRjaCh7XG4gICAgICBiYXNlUGF0aDogYmFzZSxcbiAgICAgIG1pZDogcmVzdWx0LmRhdGEubWlkLFxuICAgICAgbWlkVGl0bGU6IHJlc3VsdC5kYXRhLm1pZFRpdGxlLFxuICAgICAgc3RhdGU6IHJlc3VsdC5kYXRhLnN0YXRlLFxuICAgICAgcHJlZnM6IHsgcGxhbm5pbmdfZGVwdGg6IFwiZGVlcFwiIH0gYXMgR1NEUHJlZmVyZW5jZXMsXG4gICAgICBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlOiBcImZhbHNlXCIsXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwoZGlzcGF0Y2guYWN0aW9uLCBcImRpc3BhdGNoXCIpO1xuICAgIGlmIChkaXNwYXRjaC5hY3Rpb24gPT09IFwiZGlzcGF0Y2hcIikge1xuICAgICAgYXNzZXJ0LmVxdWFsKGRpc3BhdGNoLnVuaXRUeXBlLCBcInJlc2VhcmNoLXByb2plY3RcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoZGlzcGF0Y2gudW5pdElkLCBcIlJFU0VBUkNILVBST0pFQ1RcIik7XG4gICAgfVxuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGVlcCBwcm9qZWN0IHNldHVwOiBuZXctcHJvamVjdCBjb21tYW5kIG9ubHkgd3JpdGVzIHBsYW5uaW5nX2RlcHRoIHdpdGggLS1kZWVwXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgbGlnaHRCYXNlID0gbWFrZUNvbW1hbmRCYXNlKCk7XG4gIGNvbnN0IGRlZXBCYXNlID0gbWFrZUNvbW1hbmRCYXNlKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVDb21tYW5kR2xvYmFsRGVlcFByZWZzKGxpZ2h0QmFzZSk7XG4gICAgY29uc3QgbGlnaHRNZXNzYWdlcyA9IGF3YWl0IHJ1bk5ld1Byb2plY3RDb21tYW5kKGxpZ2h0QmFzZSwgXCJuZXctcHJvamVjdFwiKTtcbiAgICBjb25zdCBsaWdodFByZWZzUGF0aCA9IGpvaW4obGlnaHRCYXNlLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKTtcbiAgICBpZiAoZXhpc3RzU3luYyhsaWdodFByZWZzUGF0aCkpIHtcbiAgICAgIGFzc2VydC5kb2VzTm90TWF0Y2goXG4gICAgICAgIHJlYWRGaWxlU3luYyhsaWdodFByZWZzUGF0aCwgXCJ1dGYtOFwiKSxcbiAgICAgICAgL3BsYW5uaW5nX2RlcHRoXFxzKjovLFxuICAgICAgICBcInBsYWluIC9nc2QgbmV3LXByb2plY3QgbXVzdCBub3QgcGVyc2lzdCBwbGFubmluZ19kZXB0aFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgYXNzZXJ0LmVxdWFsKGxpZ2h0TWVzc2FnZXMubGVuZ3RoLCAxLCBcInBsYWluIG5ldy1wcm9qZWN0IHNob3VsZCBzdGlsbCBkaXNwYXRjaCB0aGUgbm9ybWFsIGZpcnN0IG1pbGVzdG9uZSBkaXNjdXNzaW9uXCIpO1xuICAgIGFzc2VydC5kb2VzTm90TWF0Y2goXG4gICAgICBTdHJpbmcoKGxpZ2h0TWVzc2FnZXNbMF0gYXMgYW55KS5jb250ZW50KSxcbiAgICAgIC9Gb3JlZ3JvdW5kIERlZXAgU2V0dXAgUXVlc3Rpb24gUG9saWN5LyxcbiAgICAgIFwiZ2xvYmFsIHBsYW5uaW5nX2RlcHRoIG11c3Qgbm90IG1ha2UgcGxhaW4gbmV3LXByb2plY3QgdGFrZSB0aGUgZGVlcCBmb3JlZ3JvdW5kIHNldHVwIHBhdGhcIixcbiAgICApO1xuXG4gICAgY29uc3QgZGVlcE1lc3NhZ2VzID0gYXdhaXQgcnVuTmV3UHJvamVjdENvbW1hbmQoZGVlcEJhc2UsIFwibmV3LXByb2plY3QgLS1kZWVwXCIpO1xuICAgIGNvbnN0IGRlZXBQcmVmcyA9IHJlYWRGaWxlU3luYyhqb2luKGRlZXBCYXNlLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSwgXCJ1dGYtOFwiKTtcbiAgICBhc3NlcnQubWF0Y2goZGVlcFByZWZzLCAvcGxhbm5pbmdfZGVwdGg6XFxzKmRlZXAvKTtcbiAgICBhc3NlcnQubWF0Y2goZGVlcFByZWZzLCAvd29ya2Zsb3dfcHJlZnNfY2FwdHVyZWQ6XFxzKnRydWUvKTtcbiAgICBhc3NlcnQuZXF1YWwoZGVlcE1lc3NhZ2VzLmxlbmd0aCwgMSwgXCJkZWVwIG5ldy1wcm9qZWN0IHNob3VsZCBkaXNwYXRjaCB0aGUgZm9yZWdyb3VuZCBwcm9qZWN0IHNldHVwIGludGVydmlld1wiKTtcbiAgICBhc3NlcnQubWF0Y2goU3RyaW5nKChkZWVwTWVzc2FnZXNbMF0gYXMgYW55KS5jb250ZW50KSwgL0ZvcmVncm91bmQgRGVlcCBTZXR1cCBRdWVzdGlvbiBQb2xpY3kvKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhclBlbmRpbmdBdXRvU3RhcnQobGlnaHRCYXNlKTtcbiAgICBjbGVhclBlbmRpbmdEZWVwUHJvamVjdFNldHVwKGRlZXBCYXNlKTtcbiAgICBybVN5bmMobGlnaHRCYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgcm1TeW5jKGRlZXBCYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGVlcCBwcm9qZWN0IHNldHVwOiBiYXJlIC9nc2QgaWdub3JlcyBnbG9iYWwgcGxhbm5pbmdfZGVwdGggd2l0aG91dCBwcm9qZWN0IG9wdC1pblwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQ29tbWFuZEJhc2UoKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUNvbW1hbmRHbG9iYWxEZWVwUHJlZnMoYmFzZSk7XG5cbiAgICBjb25zdCBtZXNzYWdlcyA9IGF3YWl0IHJ1bkJhcmVHc2RDb21tYW5kKGJhc2UpO1xuICAgIGNvbnN0IHByZWZzUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUFJFRkVSRU5DRVMubWRcIik7XG5cbiAgICBpZiAoZXhpc3RzU3luYyhwcmVmc1BhdGgpKSB7XG4gICAgICBhc3NlcnQuZG9lc05vdE1hdGNoKFxuICAgICAgICByZWFkRmlsZVN5bmMocHJlZnNQYXRoLCBcInV0Zi04XCIpLFxuICAgICAgICAvcGxhbm5pbmdfZGVwdGhcXHMqOi8sXG4gICAgICAgIFwiYmFyZSAvZ3NkIG11c3Qgbm90IHBlcnNpc3QgcGxhbm5pbmdfZGVwdGggZnJvbSBnbG9iYWwgcHJlZmVyZW5jZXNcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGFzc2VydC5lcXVhbChtZXNzYWdlcy5sZW5ndGgsIDEsIFwiYmFyZSAvZ3NkIHNob3VsZCBkaXNwYXRjaCB0aGUgbm9ybWFsIGZpcnN0IG1pbGVzdG9uZSBkaXNjdXNzaW9uXCIpO1xuICAgIGFzc2VydC5kb2VzTm90TWF0Y2goXG4gICAgICBTdHJpbmcoKG1lc3NhZ2VzWzBdIGFzIGFueSkuY29udGVudCksXG4gICAgICAvRm9yZWdyb3VuZCBEZWVwIFNldHVwIFF1ZXN0aW9uIFBvbGljeS8sXG4gICAgICBcImdsb2JhbCBwbGFubmluZ19kZXB0aCBtdXN0IG5vdCBtYWtlIGJhcmUgL2dzZCB0YWtlIHRoZSBkZWVwIGZvcmVncm91bmQgc2V0dXAgcGF0aFwiLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYXJQZW5kaW5nQXV0b1N0YXJ0KGJhc2UpO1xuICAgIGNsZWFyUGVuZGluZ0RlZXBQcm9qZWN0U2V0dXAoYmFzZSk7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZWVwIHByb2plY3Qgc2V0dXA6IG5ldy1wcm9qZWN0IC0tZGVlcCBjcmVhdGVzIGEgcmVhY2hhYmxlIEhFQUQgaW4gdW5ib3JuIHJlcG9zXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VVbmJvcm5Db21tYW5kUmVwbygpO1xuICB0cnkge1xuICAgIGNvbnN0IG1lc3NhZ2VzID0gYXdhaXQgcnVuTmV3UHJvamVjdENvbW1hbmQoYmFzZSwgXCJuZXctcHJvamVjdCAtLWRlZXBcIik7XG5cbiAgICBjb25zdCBzdWJqZWN0ID0gZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImxvZ1wiLCBcIi0xXCIsIFwiLS1mb3JtYXQ9JXNcIl0sIHtcbiAgICAgIGN3ZDogYmFzZSxcbiAgICAgIGVuY29kaW5nOiBcInV0Zi04XCIsXG4gICAgfSkudHJpbSgpO1xuICAgIGFzc2VydC5lcXVhbChzdWJqZWN0LCBcImNob3JlOiBpbml0IHByb2plY3RcIik7XG5cbiAgICBjb25zdCBkZWVwUHJlZnMgPSByZWFkRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSwgXCJ1dGYtOFwiKTtcbiAgICBhc3NlcnQubWF0Y2goZGVlcFByZWZzLCAvcGxhbm5pbmdfZGVwdGg6XFxzKmRlZXAvKTtcbiAgICBhc3NlcnQuZXF1YWwobWVzc2FnZXMubGVuZ3RoLCAxLCBcImRlZXAgbmV3LXByb2plY3Qgc2hvdWxkIHN0aWxsIGRpc3BhdGNoIGZvcmVncm91bmQgc2V0dXBcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKFN0cmluZygobWVzc2FnZXNbMF0gYXMgYW55KS5jb250ZW50KSwgL0ZvcmVncm91bmQgRGVlcCBTZXR1cCBRdWVzdGlvbiBQb2xpY3kvKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhclBlbmRpbmdEZWVwUHJvamVjdFNldHVwKGJhc2UpO1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGVlcCBwcm9qZWN0IHNldHVwOiBuZXctcHJvamVjdCAtLWRlZXAgdXNlcyBjd2Qgd2hlbiBuZXN0ZWQgaW5zaWRlIGEgcGFyZW50IGdpdCByZXBvXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgcGFyZW50ID0gam9pbih0bXBkaXIoKSwgYGdzZC1kZWVwLXByb2plY3QtcGFyZW50LSR7cmFuZG9tVVVJRCgpfWApO1xuICBjb25zdCBjaGlsZCA9IGpvaW4ocGFyZW50LCBcIm5lc3RlZC1hcHBcIik7XG4gIGNvbnN0IHByZXZpb3VzQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3QgcHJldmlvdXNHc2RIb21lID0gcHJvY2Vzcy5lbnYuR1NEX0hPTUU7XG4gIGNvbnN0IHByZXZpb3VzV29ya2Zsb3dQYXRoID0gcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX1BBVEg7XG4gIGNvbnN0IHByZXZpb3VzUHJvamVjdFJvb3QgPSBwcm9jZXNzLmVudi5HU0RfUFJPSkVDVF9ST09UO1xuXG4gIG1rZGlyU3luYyhjaGlsZCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJpbml0XCJdLCB7IGN3ZDogcGFyZW50LCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImNvbmZpZ1wiLCBcInVzZXIuZW1haWxcIiwgXCJ0ZXN0QHRlc3QuY29tXCJdLCB7IGN3ZDogcGFyZW50IH0pO1xuICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY29uZmlnXCIsIFwidXNlci5uYW1lXCIsIFwiVGVzdFwiXSwgeyBjd2Q6IHBhcmVudCB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGNoaWxkLCBcInBhY2thZ2UuanNvblwiKSwgJ3tcIm5hbWVcIjpcIm5lc3RlZC1hcHBcIn1cXG4nKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGNoaWxkLCBcIkdTRC1XT1JLRkxPVy5tZFwiKSwgXCIjIFRlc3QgV29ya2Zsb3dcXG5cIik7XG5cbiAgdHJ5IHtcbiAgICBwcm9jZXNzLmVudi5HU0RfSE9NRSA9IGpvaW4oY2hpbGQsIFwiLnRlc3QtZ3NkLWhvbWVcIik7XG4gICAgcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX1BBVEggPSBqb2luKGNoaWxkLCBcIkdTRC1XT1JLRkxPVy5tZFwiKTtcbiAgICBkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX1BST0pFQ1RfUk9PVDtcbiAgICBwcm9jZXNzLmNoZGlyKGNoaWxkKTtcblxuICAgIGNvbnN0IG1lc3NhZ2VzOiB1bmtub3duW10gPSBbXTtcbiAgICBjb25zdCBjdHggPSBtYWtlQ3R4KGBuZXN0ZWQtJHtyYW5kb21VVUlEKCl9YCkgYXMgYW55O1xuICAgIGNvbnN0IHBpID0gbWFrZVBpKG1lc3NhZ2VzKSBhcyBhbnk7XG4gICAgY29uc3QgeyBoYW5kbGVXb3JrZmxvd0NvbW1hbmQgfSA9IGF3YWl0IGltcG9ydChcIi4uL2NvbW1hbmRzL2hhbmRsZXJzL3dvcmtmbG93LnRzXCIpO1xuICAgIGF3YWl0IGhhbmRsZVdvcmtmbG93Q29tbWFuZChcIm5ldy1wcm9qZWN0IC0tZGVlcFwiLCBjdHgsIHBpKTtcblxuICAgIGNvbnN0IGNoaWxkUHJlZnMgPSByZWFkRmlsZVN5bmMoam9pbihjaGlsZCwgXCIuZ3NkXCIsIFwiUFJFRkVSRU5DRVMubWRcIiksIFwidXRmLThcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKGNoaWxkUHJlZnMsIC9wbGFubmluZ19kZXB0aDpcXHMqZGVlcC8pO1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIGV4aXN0c1N5bmMoam9pbihwYXJlbnQsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpKSxcbiAgICAgIGZhbHNlLFxuICAgICAgXCJuZXctcHJvamVjdCBtdXN0IG5vdCB3cml0ZSBkZWVwIHByZWZzIHRvIHRoZSBwYXJlbnQgZ2l0IHJvb3RcIixcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChtZXNzYWdlcy5sZW5ndGgsIDEpO1xuXG4gICAgY29uc3QgdmFsaWRQcm9qZWN0ID0gcmVhZEZpbGVTeW5jKFxuICAgICAgbmV3IFVSTChcIi4uL3NjaGVtYXMvX19maXh0dXJlc19fL3ZhbGlkLXByb2plY3QubWRcIiwgaW1wb3J0Lm1ldGEudXJsKSxcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihjaGlsZCwgXCIuZ3NkXCIsIFwiUFJPSkVDVC5tZFwiKSwgdmFsaWRQcm9qZWN0KTtcblxuICAgIGNvbnN0IGFkdmFuY2VkID0gYXdhaXQgY2hlY2tEZWVwUHJvamVjdFNldHVwQWZ0ZXJUdXJuKFxuICAgICAgeyBtZXNzYWdlczogW3sgcm9sZTogXCJhc3Npc3RhbnRcIiwgY29udGVudDogXCJQcm9qZWN0IGNvbnRleHQgd3JpdHRlbi5cIiB9XSB9LFxuICAgICAgY3R4LFxuICAgICAgcGFyZW50LFxuICAgICk7XG5cbiAgICBhc3NlcnQuZXF1YWwoYWR2YW5jZWQsIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChtZXNzYWdlcy5sZW5ndGgsIDIpO1xuICAgIGFzc2VydC5tYXRjaChTdHJpbmcoKG1lc3NhZ2VzWzFdIGFzIGFueSkuY29udGVudCksIC9SRVFVSVJFTUVOVFNcXC5tZC8pO1xuICB9IGZpbmFsbHkge1xuICAgIHByb2Nlc3MuY2hkaXIocHJldmlvdXNDd2QpO1xuICAgIGlmIChwcmV2aW91c0dzZEhvbWUgPT09IHVuZGVmaW5lZCkgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9IT01FO1xuICAgIGVsc2UgcHJvY2Vzcy5lbnYuR1NEX0hPTUUgPSBwcmV2aW91c0dzZEhvbWU7XG4gICAgaWYgKHByZXZpb3VzV29ya2Zsb3dQYXRoID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUEFUSDtcbiAgICBlbHNlIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QQVRIID0gcHJldmlvdXNXb3JrZmxvd1BhdGg7XG4gICAgaWYgKHByZXZpb3VzUHJvamVjdFJvb3QgPT09IHVuZGVmaW5lZCkgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9QUk9KRUNUX1JPT1Q7XG4gICAgZWxzZSBwcm9jZXNzLmVudi5HU0RfUFJPSkVDVF9ST09UID0gcHJldmlvdXNQcm9qZWN0Um9vdDtcblxuICAgIGNsZWFyUGVuZGluZ0RlZXBQcm9qZWN0U2V0dXAoY2hpbGQpO1xuICAgIHJtU3luYyhwYXJlbnQsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgeyBjbG9zZURhdGFiYXNlIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9nc2QtZGIudHNcIik7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgfSBjYXRjaCB7fVxuICB9XG59KTtcblxudGVzdChcImRlZXAgcHJvamVjdCBzZXR1cDogbmV3LXByb2plY3QgYXNrcyBpbnRlcnZpZXcgc3RhZ2VzIGluIGZvcmVncm91bmRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgY29uc3QgcHJldmlvdXNXb3JrZmxvd1BhdGggPSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUEFUSDtcbiAgcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX1BBVEggPSBqb2luKGJhc2UsIFwiR1NELVdPUktGTE9XLm1kXCIpO1xuICB3cml0ZUZpbGVTeW5jKHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QQVRILCBcIiMgVGVzdCBXb3JrZmxvd1xcblwiKTtcblxuICB0cnkge1xuICAgIGNvbnN0IG1lc3NhZ2VzOiBhbnlbXSA9IFtdO1xuICAgIGNvbnN0IGN0eCA9IG1ha2VDdHgoKSBhcyBhbnk7XG4gICAgY29uc3QgcGkgPSBtYWtlUGkobWVzc2FnZXMpIGFzIGFueTtcblxuICAgIGF3YWl0IHN0YXJ0RGVlcFByb2plY3RTZXR1cEZvcmVncm91bmQoY3R4LCBwaSwgYmFzZSwgZmFsc2UpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKG1lc3NhZ2VzLmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0Lm1hdGNoKFxuICAgICAgbWVzc2FnZXNbMF0uY29udGVudCxcbiAgICAgIC9XaGF0IGRvIHlvdSB3YW50IHRvIGJ1aWxkXFw/LyxcbiAgICAgIFwiZGVlcCBzZXR1cCBzaG91bGQgYXNrIHRoZSBwcm9qZWN0IHF1ZXN0aW9uIGluIHRoZSBmb3JlZ3JvdW5kIGNvbnZlcnNhdGlvblwiLFxuICAgICk7XG4gICAgYXNzZXJ0Lm1hdGNoKFxuICAgICAgbWVzc2FnZXNbMF0uY29udGVudCxcbiAgICAgIC9TdHJ1Y3R1cmVkIHF1ZXN0aW9ucyBhdmFpbGFibGU6XFxzKmZhbHNlLyxcbiAgICAgIFwiZm9yZWdyb3VuZCBkZWVwIHNldHVwIHNob3VsZCBmb3JjZSBwbGFpbi1jaGF0IHF1ZXN0aW9ucyBldmVuIHdoZW4gcXVlc3Rpb24gdG9vbHMgYXJlIGFjdGl2ZVwiLFxuICAgICk7XG4gICAgYXNzZXJ0Lm1hdGNoKFxuICAgICAgbWVzc2FnZXNbMF0uY29udGVudCxcbiAgICAgIC9EbyBOT1QgY2FsbCBgYXNrX3VzZXJfcXVlc3Rpb25zYC8sXG4gICAgICBcImZvcmVncm91bmQgZGVlcCBzZXR1cCBzaG91bGQgZXhwbGljaXRseSBmb3JiaWQgdGhlIGNhbmNlbGxhYmxlIHF1ZXN0aW9uIHRvb2wgcGF0aFwiLFxuICAgICk7XG5cbiAgICBjb25zdCBzdGlsbFdhaXRpbmcgPSBhd2FpdCBjaGVja0RlZXBQcm9qZWN0U2V0dXBBZnRlclR1cm4oXG4gICAgICB7XG4gICAgICAgIG1lc3NhZ2VzOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgcm9sZTogXCJhc3Npc3RhbnRcIixcbiAgICAgICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIldoYXQgZG8geW91IHdhbnQgdG8gYnVpbGQ/XCIgfV0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgICBjdHgsXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwoc3RpbGxXYWl0aW5nLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKG1lc3NhZ2VzLmxlbmd0aCwgMSwgXCJxdWVzdGlvbiB0dXJucyB3aXRob3V0IGFydGlmYWN0cyBtdXN0IG5vdCByZWRpc3BhdGNoIG9yIGF1dG8tcGF1c2VcIik7XG5cbiAgICBjb25zdCB2YWxpZFByb2plY3QgPSByZWFkRmlsZVN5bmMoXG4gICAgICBuZXcgVVJMKFwiLi4vc2NoZW1hcy9fX2ZpeHR1cmVzX18vdmFsaWQtcHJvamVjdC5tZFwiLCBpbXBvcnQubWV0YS51cmwpLFxuICAgICAgXCJ1dGYtOFwiLFxuICAgICk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBST0pFQ1QubWRcIiksIHZhbGlkUHJvamVjdCk7XG5cbiAgICBjb25zdCBhZHZhbmNlZCA9IGF3YWl0IGNoZWNrRGVlcFByb2plY3RTZXR1cEFmdGVyVHVybihcbiAgICAgIHsgbWVzc2FnZXM6IFt7IHJvbGU6IFwiYXNzaXN0YW50XCIsIGNvbnRlbnQ6IFwiUHJvamVjdCBjYXB0dXJlZC5cIiB9XSB9LFxuICAgICAgY3R4LFxuICAgICk7XG5cbiAgICBhc3NlcnQuZXF1YWwoYWR2YW5jZWQsIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChtZXNzYWdlcy5sZW5ndGgsIDIpO1xuICAgIGFzc2VydC5tYXRjaChcbiAgICAgIG1lc3NhZ2VzWzFdLmNvbnRlbnQsXG4gICAgICAvUkVRVUlSRU1FTlRTXFwubWQvLFxuICAgICAgXCJhZnRlciBQUk9KRUNULm1kIGV4aXN0cywgZGVlcCBzZXR1cCBzaG91bGQgZm9yZWdyb3VuZCB0aGUgcmVxdWlyZW1lbnRzIGludGVydmlld1wiLFxuICAgICk7XG4gICAgYXNzZXJ0Lm1hdGNoKFxuICAgICAgbWVzc2FnZXNbMV0uY29udGVudCxcbiAgICAgIC9TdHJ1Y3R1cmVkIHF1ZXN0aW9ucyBhdmFpbGFibGU6XFxzKmZhbHNlLyxcbiAgICAgIFwicmVxdWlyZW1lbnRzIGZvcmVncm91bmQgc2V0dXAgc2hvdWxkIGFsc28gZm9yY2UgcGxhaW4tY2hhdCBxdWVzdGlvbnNcIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFyUGVuZGluZ0RlZXBQcm9qZWN0U2V0dXAoYmFzZSk7XG4gICAgaWYgKHByZXZpb3VzV29ya2Zsb3dQYXRoID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUEFUSDtcbiAgICB9IGVsc2Uge1xuICAgICAgcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX1BBVEggPSBwcmV2aW91c1dvcmtmbG93UGF0aDtcbiAgICB9XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZWVwIGF1dG8gZGlzcGF0Y2ggZm9yY2VzIG1pbGVzdG9uZSBjaGVja3BvaW50cyBpbnRvIHBsYWluIGNoYXRcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgY29uc3QgcyA9IG5ldyBBdXRvU2Vzc2lvbigpO1xuICBzLmJhc2VQYXRoID0gYmFzZTtcbiAgcy5vcmlnaW5hbEJhc2VQYXRoID0gYmFzZTtcblxuICBsZXQgY2FwdHVyZWRTdHJ1Y3R1cmVkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGNvbnN0IGRlcHMgPSB7XG4gICAgcmVzb2x2ZURpc3BhdGNoOiBhc3luYyAoZGlzcGF0Y2hDdHg6IGFueSkgPT4ge1xuICAgICAgY2FwdHVyZWRTdHJ1Y3R1cmVkID0gZGlzcGF0Y2hDdHguc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFjdGlvbjogXCJkaXNwYXRjaFwiIGFzIGNvbnN0LFxuICAgICAgICB1bml0VHlwZTogXCJkaXNjdXNzLW1pbGVzdG9uZVwiLFxuICAgICAgICB1bml0SWQ6IFwiTTAwMVwiLFxuICAgICAgICBwcm9tcHQ6IGBTdHJ1Y3R1cmVkIHF1ZXN0aW9ucyBhdmFpbGFibGU6ICR7ZGlzcGF0Y2hDdHguc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZX1gLFxuICAgICAgICBtYXRjaGVkUnVsZTogXCJ0ZXN0XCIsXG4gICAgICB9O1xuICAgIH0sXG4gICAgZW1pdEpvdXJuYWxFdmVudDogKCkgPT4ge30sXG4gICAgcnVuUHJlRGlzcGF0Y2hIb29rczogKCkgPT4gKHsgZmlyZWRIb29rczogW10sIGFjdGlvbjogXCJwcm9jZWVkXCIgfSksXG4gICAgZ2V0UHJpb3JTbGljZUNvbXBsZXRpb25CbG9ja2VyOiAoKSA9PiBudWxsLFxuICAgIGdldE1haW5CcmFuY2g6ICgpID0+IFwibWFpblwiLFxuICAgIGludmFsaWRhdGVBbGxDYWNoZXM6ICgpID0+IHt9LFxuICAgIHN0b3BBdXRvOiBhc3luYyAoKSA9PiB7fSxcbiAgICBwYXVzZUF1dG86IGFzeW5jICgpID0+IHt9LFxuICB9O1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkRpc3BhdGNoKFxuICAgIHtcbiAgICAgIGN0eDogbWFrZUN0eCgpIGFzIGFueSxcbiAgICAgIHBpOiBtYWtlUGkoW10pIGFzIGFueSxcbiAgICAgIHMsXG4gICAgICBkZXBzOiBkZXBzIGFzIGFueSxcbiAgICAgIHByZWZzOiB7IHBsYW5uaW5nX2RlcHRoOiBcImRlZXBcIiB9IGFzIGFueSxcbiAgICAgIGl0ZXJhdGlvbjogMSxcbiAgICAgIGZsb3dJZDogXCJmbG93LXRlc3RcIixcbiAgICAgIG5leHRTZXE6ICgpID0+IDEsXG4gICAgfSxcbiAgICB7XG4gICAgICBzdGF0ZToge1xuICAgICAgICBwaGFzZTogXCJwcmUtcGxhbm5pbmdcIixcbiAgICAgICAgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiUGxhaW4gQ2hhdCBHYXRlXCIgfSxcbiAgICAgICAgYWN0aXZlU2xpY2U6IG51bGwsXG4gICAgICAgIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgICAgIHJlY2VudERlY2lzaW9uczogW10sXG4gICAgICAgIGJsb2NrZXJzOiBbXSxcbiAgICAgICAgbmV4dEFjdGlvbjogXCJcIixcbiAgICAgICAgcmVnaXN0cnk6IFtdLFxuICAgICAgfSxcbiAgICAgIG1pZDogXCJNMDAxXCIsXG4gICAgICBtaWRUaXRsZTogXCJQbGFpbiBDaGF0IEdhdGVcIixcbiAgICB9LFxuICAgIHtcbiAgICAgIHJlY2VudFVuaXRzOiBbXSxcbiAgICAgIHN0dWNrUmVjb3ZlcnlBdHRlbXB0czogMCxcbiAgICAgIGNvbnNlY3V0aXZlRmluYWxpemVUaW1lb3V0czogMCxcbiAgICB9LFxuICApO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcIm5leHRcIik7XG4gIGFzc2VydC5lcXVhbChjYXB0dXJlZFN0cnVjdHVyZWQsIFwiZmFsc2VcIik7XG4gIGlmIChyZXN1bHQuYWN0aW9uID09PSBcIm5leHRcIikge1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQuZGF0YS5wcm9tcHQsIC9TdHJ1Y3R1cmVkIHF1ZXN0aW9ucyBhdmFpbGFibGU6IGZhbHNlLyk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGVlcCBwcm9qZWN0IHNldHVwOiB1bnJlbGF0ZWQgYWdlbnRfZW5kIHNlc3Npb25zIGRvIG5vdCBhZHZhbmNlIHBlbmRpbmcgc2V0dXBcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgY29uc3Qgb3RoZXJCYXNlID0gbWFrZUJhc2UoKTtcbiAgY29uc3QgcHJldmlvdXNXb3JrZmxvd1BhdGggPSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUEFUSDtcbiAgcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX1BBVEggPSBqb2luKGJhc2UsIFwiR1NELVdPUktGTE9XLm1kXCIpO1xuICB3cml0ZUZpbGVTeW5jKHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QQVRILCBcIiMgVGVzdCBXb3JrZmxvd1xcblwiKTtcblxuICB0cnkge1xuICAgIGNvbnN0IG1lc3NhZ2VzOiBhbnlbXSA9IFtdO1xuICAgIGNvbnN0IGRlZXBDdHggPSBtYWtlQ3R4KFwiZGVlcC1zZXNzaW9uXCIpIGFzIGFueTtcbiAgICBjb25zdCBvdGhlckN0eCA9IG1ha2VDdHgoXCJvdGhlci1zZXNzaW9uXCIpIGFzIGFueTtcbiAgICBjb25zdCBwaSA9IG1ha2VQaShtZXNzYWdlcykgYXMgYW55O1xuXG4gICAgYXdhaXQgc3RhcnREZWVwUHJvamVjdFNldHVwRm9yZWdyb3VuZChkZWVwQ3R4LCBwaSwgYmFzZSwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChtZXNzYWdlcy5sZW5ndGgsIDEpO1xuXG4gICAgY29uc3QgdmFsaWRQcm9qZWN0ID0gcmVhZEZpbGVTeW5jKFxuICAgICAgbmV3IFVSTChcIi4uL3NjaGVtYXMvX19maXh0dXJlc19fL3ZhbGlkLXByb2plY3QubWRcIiwgaW1wb3J0Lm1ldGEudXJsKSxcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJQUk9KRUNULm1kXCIpLCB2YWxpZFByb2plY3QpO1xuXG4gICAgY29uc3QgaWdub3JlZCA9IGF3YWl0IGNoZWNrRGVlcFByb2plY3RTZXR1cEFmdGVyVHVybihcbiAgICAgIHsgbWVzc2FnZXM6IFt7IHJvbGU6IFwiYXNzaXN0YW50XCIsIGNvbnRlbnQ6IFwiVW5yZWxhdGVkIGxpZ2h0IHdvcmtmbG93IGNvbXBsZXRlZC5cIiB9XSB9LFxuICAgICAgb3RoZXJDdHgsXG4gICAgICBvdGhlckJhc2UsXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwoaWdub3JlZCwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChtZXNzYWdlcy5sZW5ndGgsIDEsIFwidW5yZWxhdGVkIHNlc3Npb24gbXVzdCBub3QgY29uc3VtZSBvciBhZHZhbmNlIHBlbmRpbmcgZGVlcCBzZXR1cFwiKTtcblxuICAgIGNvbnN0IGFkdmFuY2VkID0gYXdhaXQgY2hlY2tEZWVwUHJvamVjdFNldHVwQWZ0ZXJUdXJuKFxuICAgICAgeyBtZXNzYWdlczogW3sgcm9sZTogXCJhc3Npc3RhbnRcIiwgY29udGVudDogXCJQcm9qZWN0IGNhcHR1cmVkLlwiIH1dIH0sXG4gICAgICBkZWVwQ3R4LFxuICAgICAgYmFzZSxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChhZHZhbmNlZCwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKG1lc3NhZ2VzLmxlbmd0aCwgMiwgXCJvd25pbmcgc2Vzc2lvbiBzaG91bGQgc3RpbGwgYWR2YW5jZSBwZW5kaW5nIGRlZXAgc2V0dXBcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYXJQZW5kaW5nRGVlcFByb2plY3RTZXR1cChiYXNlKTtcbiAgICBpZiAocHJldmlvdXNXb3JrZmxvd1BhdGggPT09IHVuZGVmaW5lZCkge1xuICAgICAgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QQVRIO1xuICAgIH0gZWxzZSB7XG4gICAgICBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUEFUSCA9IHByZXZpb3VzV29ya2Zsb3dQYXRoO1xuICAgIH1cbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIHJtU3luYyhvdGhlckJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZWVwIHByb2plY3Qgc2V0dXA6IHNhbWUgcHJvamVjdCBhZHZhbmNlcyB3aGVuIGFnZW50X2VuZCBzZXNzaW9uIGlkIGNoYW5nZXNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgY29uc3QgcHJldmlvdXNXb3JrZmxvd1BhdGggPSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUEFUSDtcbiAgcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX1BBVEggPSBqb2luKGJhc2UsIFwiR1NELVdPUktGTE9XLm1kXCIpO1xuICB3cml0ZUZpbGVTeW5jKHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QQVRILCBcIiMgVGVzdCBXb3JrZmxvd1xcblwiKTtcblxuICB0cnkge1xuICAgIGNvbnN0IG1lc3NhZ2VzOiBhbnlbXSA9IFtdO1xuICAgIGNvbnN0IHN0YXJ0Q3R4ID0gbWFrZUN0eChcInN0YXJ0LXNlc3Npb25cIikgYXMgYW55O1xuICAgIGNvbnN0IGZpbmlzaEN0eCA9IG1ha2VDdHgoXCJmaW5pc2gtc2Vzc2lvblwiKSBhcyBhbnk7XG4gICAgY29uc3QgcGkgPSBtYWtlUGkobWVzc2FnZXMpIGFzIGFueTtcblxuICAgIGF3YWl0IHN0YXJ0RGVlcFByb2plY3RTZXR1cEZvcmVncm91bmQoc3RhcnRDdHgsIHBpLCBiYXNlLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKG1lc3NhZ2VzLmxlbmd0aCwgMSk7XG5cbiAgICBjb25zdCB2YWxpZFByb2plY3QgPSByZWFkRmlsZVN5bmMoXG4gICAgICBuZXcgVVJMKFwiLi4vc2NoZW1hcy9fX2ZpeHR1cmVzX18vdmFsaWQtcHJvamVjdC5tZFwiLCBpbXBvcnQubWV0YS51cmwpLFxuICAgICAgXCJ1dGYtOFwiLFxuICAgICk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBST0pFQ1QubWRcIiksIHZhbGlkUHJvamVjdCk7XG5cbiAgICBjb25zdCBhZHZhbmNlZCA9IGF3YWl0IGNoZWNrRGVlcFByb2plY3RTZXR1cEFmdGVyVHVybihcbiAgICAgIHsgbWVzc2FnZXM6IFt7IHJvbGU6IFwiYXNzaXN0YW50XCIsIGNvbnRlbnQ6IFwiUHJvamVjdCBjYXB0dXJlZC5cIiB9XSB9LFxuICAgICAgZmluaXNoQ3R4LFxuICAgICAgYmFzZSxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChhZHZhbmNlZCwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKG1lc3NhZ2VzLmxlbmd0aCwgMiwgXCJzYW1lIHByb2plY3Qgc2hvdWxkIGFkdmFuY2UgZXZlbiBpZiB0aGUgYWdlbnRfZW5kIHNlc3Npb24gaWQgY2hhbmdlZFwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhclBlbmRpbmdEZWVwUHJvamVjdFNldHVwKGJhc2UpO1xuICAgIGlmIChwcmV2aW91c1dvcmtmbG93UGF0aCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX1BBVEg7XG4gICAgfSBlbHNlIHtcbiAgICAgIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QQVRIID0gcHJldmlvdXNXb3JrZmxvd1BhdGg7XG4gICAgfVxuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGVlcCBwcm9qZWN0IHNldHVwOiBmb3JlZ3JvdW5kIGRpc3BhdGNoZXIgZG9lcyBub3QgcHJvYmUgcmVzZWFyY2gtcHJvamVjdCBydWxlXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKEZPUkVHUk9VTkRfREVFUF9TRVRVUF9SVUxFX05BTUVTLmhhcyhcImRlZXA6IHByZS1wbGFubmluZyAobm8gUFJPSkVDVCkgXHUyMTkyIGRpc2N1c3MtcHJvamVjdFwiKSwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChGT1JFR1JPVU5EX0RFRVBfU0VUVVBfUlVMRV9OQU1FUy5oYXMoXCJkZWVwOiBwcmUtcGxhbm5pbmcgKG5vIHJlc2VhcmNoIGRlY2lzaW9uKSBcdTIxOTIgcmVzZWFyY2gtZGVjaXNpb25cIiksIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoRk9SRUdST1VORF9ERUVQX1NFVFVQX1JVTEVfTkFNRVMuaGFzKFwiZGVlcDogcHJlLXBsYW5uaW5nIChubyBQUk9KRUNUIHJlc2VhcmNoKSBcdTIxOTIgcmVzZWFyY2gtcHJvamVjdFwiKSwgZmFsc2UpO1xufSk7XG5cbnRlc3QoXCJkZWVwIHByb2plY3Qgc2V0dXA6IHByb2plY3QtbGV2ZWwgdW5pdHMgdmVyaWZ5IHRoZWlyIHJlYWwgYXJ0aWZhY3RzXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIHRyeSB7XG4gICAgYXNzZXJ0LmVxdWFsKHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJ3b3JrZmxvdy1wcmVmZXJlbmNlc1wiLCBcIldPUktGTE9XLVBSRUZTXCIsIGJhc2UpLCBmYWxzZSk7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUFJFRkVSRU5DRVMubWRcIiksXG4gICAgICBcIi0tLVxcbnBsYW5uaW5nX2RlcHRoOiBkZWVwXFxud29ya2Zsb3dfcHJlZnNfY2FwdHVyZWQ6IHRydWVcXG4tLS1cXG5cIixcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbCh2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFwid29ya2Zsb3ctcHJlZmVyZW5jZXNcIiwgXCJXT1JLRkxPVy1QUkVGU1wiLCBiYXNlKSwgdHJ1ZSk7XG5cbiAgICBjb25zdCB2YWxpZFByb2plY3QgPSByZWFkRmlsZVN5bmMoXG4gICAgICBuZXcgVVJMKFwiLi4vc2NoZW1hcy9fX2ZpeHR1cmVzX18vdmFsaWQtcHJvamVjdC5tZFwiLCBpbXBvcnQubWV0YS51cmwpLFxuICAgICAgXCJ1dGYtOFwiLFxuICAgICk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBST0pFQ1QubWRcIiksIHZhbGlkUHJvamVjdCk7XG4gICAgYXNzZXJ0LmVxdWFsKHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJkaXNjdXNzLXByb2plY3RcIiwgXCJQUk9KRUNUXCIsIGJhc2UpLCB0cnVlKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUFJPSkVDVC5tZFwiKSwgXCIjIFByb2plY3RcXG5cIik7XG4gICAgYXNzZXJ0LmVxdWFsKHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJkaXNjdXNzLXByb2plY3RcIiwgXCJQUk9KRUNUXCIsIGJhc2UpLCBmYWxzZSk7XG5cbiAgICBjb25zdCB2YWxpZFJlcXVpcmVtZW50cyA9IHJlYWRGaWxlU3luYyhcbiAgICAgIG5ldyBVUkwoXCIuLi9zY2hlbWFzL19fZml4dHVyZXNfXy92YWxpZC1yZXF1aXJlbWVudHMubWRcIiwgaW1wb3J0Lm1ldGEudXJsKSxcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJSRVFVSVJFTUVOVFMubWRcIiksIHZhbGlkUmVxdWlyZW1lbnRzKTtcbiAgICBhc3NlcnQuZXF1YWwodmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdChcImRpc2N1c3MtcmVxdWlyZW1lbnRzXCIsIFwiUkVRVUlSRU1FTlRTXCIsIGJhc2UpLCB0cnVlKTtcblxuICAgIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIsIFwicmVzZWFyY2gtZGVjaXNpb24uanNvblwiKSwgJ3tcImRlY2lzaW9uXCI6XCJtYXliZVwifVxcbicpO1xuICAgIGFzc2VydC5lcXVhbCh2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFwicmVzZWFyY2gtZGVjaXNpb25cIiwgXCJSRVNFQVJDSC1ERUNJU0lPTlwiLCBiYXNlKSwgZmFsc2UpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIsIFwicmVzZWFyY2gtZGVjaXNpb24uanNvblwiKSwgJ3tcImRlY2lzaW9uXCI6XCJza2lwXCJ9XFxuJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJyZXNlYXJjaC1kZWNpc2lvblwiLCBcIlJFU0VBUkNILURFQ0lTSU9OXCIsIGJhc2UpLCB0cnVlKTtcblxuICAgIGNvbnN0IHJlc2VhcmNoRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJyZXNlYXJjaFwiKTtcbiAgICBta2RpclN5bmMocmVzZWFyY2hEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXNlYXJjaERpciwgXCJTVEFDSy5tZFwiKSwgXCIjIFN0YWNrXFxuXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXNlYXJjaERpciwgXCJGRUFUVVJFUy5tZFwiKSwgXCIjIEZlYXR1cmVzXFxuXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXNlYXJjaERpciwgXCJBUkNISVRFQ1RVUkUubWRcIiksIFwiIyBBcmNoaXRlY3R1cmVcXG5cIik7XG4gICAgYXNzZXJ0LmVxdWFsKHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJyZXNlYXJjaC1wcm9qZWN0XCIsIFwiUFJPSkVDVC1SRVNFQVJDSFwiLCBiYXNlKSwgZmFsc2UpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXNlYXJjaERpciwgXCJQSVRGQUxMUy1CTE9DS0VSLm1kXCIpLCBcIiMgQmxvY2tlZFxcblwiKTtcbiAgICBhc3NlcnQuZXF1YWwodmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdChcInJlc2VhcmNoLXByb2plY3RcIiwgXCJQUk9KRUNULVJFU0VBUkNIXCIsIGJhc2UpLCB0cnVlKTtcblxuICAgIGZvciAoY29uc3QgbmFtZSBvZiBbXCJTVEFDSy5tZFwiLCBcIkZFQVRVUkVTLm1kXCIsIFwiQVJDSElURUNUVVJFLm1kXCJdKSB7XG4gICAgICBybVN5bmMoam9pbihyZXNlYXJjaERpciwgbmFtZSksIHsgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgbmFtZSBvZiBbXCJTVEFDS1wiLCBcIkZFQVRVUkVTXCIsIFwiQVJDSElURUNUVVJFXCJdKSB7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocmVzZWFyY2hEaXIsIGAke25hbWV9LUJMT0NLRVIubWRgKSwgXCIjIEJsb2NrZWRcXG5cIik7XG4gICAgfVxuICAgIGFzc2VydC5lcXVhbCh2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFwicmVzZWFyY2gtcHJvamVjdFwiLCBcIlBST0pFQ1QtUkVTRUFSQ0hcIiwgYmFzZSksIGZhbHNlKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcImRlZXAgcHJvamVjdCBzZXR1cDogcmVzZWFyY2gtcHJvamVjdCBibG9ja2VyIHBsYWNlaG9sZGVyIGlzIGEgZmlsZSwgbm90IHRoZSByZXNlYXJjaCBkaXJlY3RvcnlcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBleHBlY3RlZFBhdGggPSByZXNvbHZlRXhwZWN0ZWRBcnRpZmFjdFBhdGgoXCJyZXNlYXJjaC1wcm9qZWN0XCIsIFwiUFJPSkVDVC1SRVNFQVJDSFwiLCBiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwoZXhwZWN0ZWRQYXRoLCBqb2luKHJlYWxwYXRoU3luYyhiYXNlKSwgXCIuZ3NkXCIsIFwicmVzZWFyY2hcIiwgXCJQUk9KRUNULVJFU0VBUkNILUJMT0NLRVIubWRcIikpO1xuXG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicmVzZWFyY2hcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGNvbnN0IGRpYWdub3NpcyA9IHdyaXRlQmxvY2tlclBsYWNlaG9sZGVyKFxuICAgICAgXCJyZXNlYXJjaC1wcm9qZWN0XCIsXG4gICAgICBcIlBST0pFQ1QtUkVTRUFSQ0hcIixcbiAgICAgIGJhc2UsXG4gICAgICBcInRlc3QgcmVjb3ZlcnlcIixcbiAgICApO1xuXG4gICAgYXNzZXJ0Lm1hdGNoKGRpYWdub3NpcyA/PyBcIlwiLCAvcmVzZWFyY2gvaSk7XG4gICAgYXNzZXJ0LmVxdWFsKGV4aXN0c1N5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJyZXNlYXJjaFwiLCBcIlBST0pFQ1QtUkVTRUFSQ0gtQkxPQ0tFUi5tZFwiKSksIHRydWUpO1xuICAgIGFzc2VydC5tYXRjaChcbiAgICAgIHJlYWRGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJlc2VhcmNoXCIsIFwiUFJPSkVDVC1SRVNFQVJDSC1CTE9DS0VSLm1kXCIpLCBcInV0Zi04XCIpLFxuICAgICAgL2ZhaWwtY2xvc2VkLyxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJyZXNlYXJjaC1wcm9qZWN0XCIsIFwiUFJPSkVDVC1SRVNFQVJDSFwiLCBiYXNlKSxcbiAgICAgIGZhbHNlLFxuICAgICAgXCJwcm9qZWN0IHJlc2VhcmNoIGJsb2NrZXIgcGxhY2Vob2xkZXJzIG11c3Qgbm90IHNhdGlzZnkgdGhlIHJlc2VhcmNoIGdhdGVcIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGVlcCBwcm9qZWN0IHNldHVwOiByZXNlYXJjaC1wcm9qZWN0IHBhcnRpYWwgb3V0cHV0IHdyaXRlcyBkaW1lbnNpb24gYmxvY2tlcnMgaW5zdGVhZCBvZiByZXRyeWluZ1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICB0cnkge1xuICAgIGNvbnN0IHMgPSBuZXcgQXV0b1Nlc3Npb24oKTtcbiAgICBzLmFjdGl2ZSA9IHRydWU7XG4gICAgcy5iYXNlUGF0aCA9IGJhc2U7XG4gICAgcy5jdXJyZW50VW5pdCA9IHsgdHlwZTogXCJyZXNlYXJjaC1wcm9qZWN0XCIsIGlkOiBcIlJFU0VBUkNILVBST0pFQ1RcIiwgc3RhcnRlZEF0OiBEYXRlLm5vdygpIH07XG5cbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiLCBcInJlc2VhcmNoLXByb2plY3QtaW5mbGlnaHRcIiksIFwie31cXG5cIik7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicmVzZWFyY2hcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJyZXNlYXJjaFwiLCBcIlNUQUNLLm1kXCIpLCBcIiMgU3RhY2tcXG5cIik7XG5cbiAgICBjb25zdCBub3RpZmljYXRpb25zOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBvc3RVbml0UHJlVmVyaWZpY2F0aW9uKFxuICAgICAge1xuICAgICAgICBzLFxuICAgICAgICBjdHg6IHsgdWk6IHsgbm90aWZ5OiAobWVzc2FnZTogc3RyaW5nKSA9PiBub3RpZmljYXRpb25zLnB1c2gobWVzc2FnZSkgfSB9IGFzIGFueSxcbiAgICAgICAgcGk6IHt9IGFzIGFueSxcbiAgICAgICAgYnVpbGRTbmFwc2hvdE9wdHM6ICgpID0+ICh7fSkgYXMgYW55LFxuICAgICAgICBsb2NrQmFzZTogKCkgPT4gYmFzZSxcbiAgICAgICAgc3RvcEF1dG86IGFzeW5jICgpID0+IHt9LFxuICAgICAgICBwYXVzZUF1dG86IGFzeW5jICgpID0+IHt9LFxuICAgICAgICB1cGRhdGVQcm9ncmVzc1dpZGdldDogKCkgPT4ge30sXG4gICAgICB9LFxuICAgICAgeyBza2lwU2V0dGxlRGVsYXk6IHRydWUsIHNraXBXb3JrdHJlZVN5bmM6IHRydWUgfSxcbiAgICApO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJjb250aW51ZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiwgXCJyZXNlYXJjaC1wcm9qZWN0LWluZmxpZ2h0XCIpKSwgZmFsc2UpO1xuICAgIGZvciAoY29uc3QgbmFtZSBvZiBbXCJGRUFUVVJFU1wiLCBcIkFSQ0hJVEVDVFVSRVwiLCBcIlBJVEZBTExTXCJdKSB7XG4gICAgICBhc3NlcnQuZXF1YWwoZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJlc2VhcmNoXCIsIGAke25hbWV9LUJMT0NLRVIubWRgKSksIHRydWUpO1xuICAgIH1cbiAgICBhc3NlcnQuZXF1YWwodmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdChcInJlc2VhcmNoLXByb2plY3RcIiwgXCJSRVNFQVJDSC1QUk9KRUNUXCIsIGJhc2UpLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwocy5wZW5kaW5nVmVyaWZpY2F0aW9uUmV0cnksIG51bGwpO1xuICAgIGFzc2VydC5lcXVhbChzLnZlcmlmaWNhdGlvblJldHJ5Q291bnQuc2l6ZSwgMCk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgbm90aWZpY2F0aW9ucy5zb21lKChtZXNzYWdlKSA9PiBtZXNzYWdlLmluY2x1ZGVzKFwid2l0aG91dCByZXJ1bm5pbmcgYWxsIHNjb3V0c1wiKSksXG4gICAgICBcInNob3VsZCBub3RpZnkgdGhhdCBwYXJ0aWFsIHJlc2VhcmNoIHdhcyBmaW5hbGl6ZWQgd2l0aG91dCBhbm90aGVyIGZ1bGwgZmFuLW91dFwiLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZWVwIHByb2plY3Qgc2V0dXA6IHJlc2VhcmNoLXByb2plY3QgZW1wdHkgb3V0cHV0IHdyaXRlcyBnbG9iYWwgYmxvY2tlciB3aXRob3V0IHJldHJ5aW5nXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcyA9IG5ldyBBdXRvU2Vzc2lvbigpO1xuICAgIHMuYWN0aXZlID0gdHJ1ZTtcbiAgICBzLmJhc2VQYXRoID0gYmFzZTtcbiAgICBzLmN1cnJlbnRVbml0ID0geyB0eXBlOiBcInJlc2VhcmNoLXByb2plY3RcIiwgaWQ6IFwiUkVTRUFSQ0gtUFJPSkVDVFwiLCBzdGFydGVkQXQ6IERhdGUubm93KCkgfTtcblxuICAgIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIsIFwicmVzZWFyY2gtcHJvamVjdC1pbmZsaWdodFwiKSwgXCJ7fVxcblwiKTtcblxuICAgIGNvbnN0IG5vdGlmaWNhdGlvbnM6IHN0cmluZ1tdID0gW107XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcG9zdFVuaXRQcmVWZXJpZmljYXRpb24oXG4gICAgICB7XG4gICAgICAgIHMsXG4gICAgICAgIGN0eDogeyB1aTogeyBub3RpZnk6IChtZXNzYWdlOiBzdHJpbmcpID0+IG5vdGlmaWNhdGlvbnMucHVzaChtZXNzYWdlKSB9IH0gYXMgYW55LFxuICAgICAgICBwaToge30gYXMgYW55LFxuICAgICAgICBidWlsZFNuYXBzaG90T3B0czogKCkgPT4gKHt9KSBhcyBhbnksXG4gICAgICAgIGxvY2tCYXNlOiAoKSA9PiBiYXNlLFxuICAgICAgICBzdG9wQXV0bzogYXN5bmMgKCkgPT4ge30sXG4gICAgICAgIHBhdXNlQXV0bzogYXN5bmMgKCkgPT4ge30sXG4gICAgICAgIHVwZGF0ZVByb2dyZXNzV2lkZ2V0OiAoKSA9PiB7fSxcbiAgICAgIH0sXG4gICAgICB7IHNraXBTZXR0bGVEZWxheTogdHJ1ZSwgc2tpcFdvcmt0cmVlU3luYzogdHJ1ZSB9LFxuICAgICk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBcImNvbnRpbnVlXCIpO1xuICAgIGFzc2VydC5lcXVhbChleGlzdHNTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiLCBcInJlc2VhcmNoLXByb2plY3QtaW5mbGlnaHRcIikpLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGV4aXN0c1N5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJyZXNlYXJjaFwiLCBcIlBST0pFQ1QtUkVTRUFSQ0gtQkxPQ0tFUi5tZFwiKSksIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbCh2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFwicmVzZWFyY2gtcHJvamVjdFwiLCBcIlJFU0VBUkNILVBST0pFQ1RcIiwgYmFzZSksIGZhbHNlKTtcbiAgICBhc3NlcnQuZXF1YWwocy5wZW5kaW5nVmVyaWZpY2F0aW9uUmV0cnksIG51bGwpO1xuICAgIGFzc2VydC5lcXVhbChzLnZlcmlmaWNhdGlvblJldHJ5Q291bnQuc2l6ZSwgMCk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgbm90aWZpY2F0aW9ucy5zb21lKChtZXNzYWdlKSA9PiBtZXNzYWdlLmluY2x1ZGVzKFwiUFJPSkVDVC1SRVNFQVJDSC1CTE9DS0VSLm1kXCIpKSxcbiAgICAgIFwic2hvdWxkIG5vdGlmeSB0aGF0IHByb2plY3QgcmVzZWFyY2ggaXMgZmFpbC1jbG9zZWRcIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGVlcCBwcm9qZWN0IHNldHVwOiBwcm9qZWN0IHJlc2VhcmNoIHRpbWVvdXQgZmluYWxpemVyIHJlbW92ZXMgc3RhbGUgbWFya2VyXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiwgXCJyZXNlYXJjaC1wcm9qZWN0LWluZmxpZ2h0XCIpLCBcInt9XFxuXCIpO1xuXG4gICAgY29uc3Qgb3V0Y29tZSA9IGZpbmFsaXplUHJvamVjdFJlc2VhcmNoVGltZW91dChiYXNlLCBcInRlc3QgaGFyZCB0aW1lb3V0XCIpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKG91dGNvbWUua2luZCwgXCJnbG9iYWwtYmxvY2tlclwiKTtcbiAgICBhc3NlcnQuZXF1YWwoZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiwgXCJyZXNlYXJjaC1wcm9qZWN0LWluZmxpZ2h0XCIpKSwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChleGlzdHNTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicmVzZWFyY2hcIiwgXCJQUk9KRUNULVJFU0VBUkNILUJMT0NLRVIubWRcIikpLCB0cnVlKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcImRlZXAgcHJvamVjdCBzZXR1cDogcmVzZWFyY2gtcHJvamVjdCBzdXBlcnZpc2lvbiB0aW1lb3V0IGlzIGNhcHBlZCBuYXJyb3dseVwiLCAoKSA9PiB7XG4gIGNvbnN0IGRlZmF1bHRzID0ge1xuICAgIHNvZnRfdGltZW91dF9taW51dGVzOiAyMCxcbiAgICBpZGxlX3RpbWVvdXRfbWludXRlczogMTAsXG4gICAgaGFyZF90aW1lb3V0X21pbnV0ZXM6IDMwLFxuICB9O1xuXG4gIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgcmVzb2x2ZVVuaXRTdXBlcnZpc2lvblRpbWVvdXRzKFwicmVzZWFyY2gtcHJvamVjdFwiLCBkZWZhdWx0cywgMSksXG4gICAge1xuICAgICAgc29mdFRpbWVvdXRNczogMyAqIDYwICogMTAwMCxcbiAgICAgIGlkbGVUaW1lb3V0TXM6IDEwICogNjAgKiAxMDAwLFxuICAgICAgaGFyZFRpbWVvdXRNczogNSAqIDYwICogMTAwMCxcbiAgICB9LFxuICApO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgcmVzb2x2ZVVuaXRTdXBlcnZpc2lvblRpbWVvdXRzKFwicmVzZWFyY2gtcHJvamVjdFwiLCB7XG4gICAgICBzb2Z0X3RpbWVvdXRfbWludXRlczogMixcbiAgICAgIGlkbGVfdGltZW91dF9taW51dGVzOiAxMCxcbiAgICAgIGhhcmRfdGltZW91dF9taW51dGVzOiA0LFxuICAgIH0sIDEpLFxuICAgIHtcbiAgICAgIHNvZnRUaW1lb3V0TXM6IDIgKiA2MCAqIDEwMDAsXG4gICAgICBpZGxlVGltZW91dE1zOiAxMCAqIDYwICogMTAwMCxcbiAgICAgIGhhcmRUaW1lb3V0TXM6IDQgKiA2MCAqIDEwMDAsXG4gICAgfSxcbiAgKTtcblxuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIHJlc29sdmVVbml0U3VwZXJ2aXNpb25UaW1lb3V0cyhcInBsYW4tc2xpY2VcIiwgZGVmYXVsdHMsIDIpLFxuICAgIHtcbiAgICAgIHNvZnRUaW1lb3V0TXM6IDQwICogNjAgKiAxMDAwLFxuICAgICAgaWRsZVRpbWVvdXRNczogMTAgKiA2MCAqIDEwMDAsXG4gICAgICBoYXJkVGltZW91dE1zOiA2MCAqIDYwICogMTAwMCxcbiAgICB9LFxuICApO1xufSk7XG5cbnRlc3QoXCJkZWVwIHByb2plY3Qgc2V0dXA6IGVtcHR5IGxlZ2FjeSBwc2V1ZG8tbWlsZXN0b25lIGRpcnMgZG8gbm90IGJsb2NrIGZpcnN0IHJlYWwgbWlsZXN0b25lXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIGNvbnN0IHByZXZpb3VzV29ya2Zsb3dQYXRoID0gcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX1BBVEg7XG4gIGNvbnN0IHdvcmtmbG93UGF0aCA9IGpvaW4oYmFzZSwgXCJHU0QtV09SS0ZMT1cubWRcIik7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyh3b3JrZmxvd1BhdGgsIFwiIyBUZXN0IFdvcmtmbG93XFxuXCIpO1xuICAgIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QQVRIID0gd29ya2Zsb3dQYXRoO1xuXG4gICAgY29uc3QgdmFsaWRQcm9qZWN0ID0gcmVhZEZpbGVTeW5jKFxuICAgICAgbmV3IFVSTChcIi4uL3NjaGVtYXMvX19maXh0dXJlc19fL3ZhbGlkLXByb2plY3QubWRcIiwgaW1wb3J0Lm1ldGEudXJsKSxcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuICAgIGNvbnN0IHZhbGlkUmVxdWlyZW1lbnRzID0gcmVhZEZpbGVTeW5jKFxuICAgICAgbmV3IFVSTChcIi4uL3NjaGVtYXMvX19maXh0dXJlc19fL3ZhbGlkLXJlcXVpcmVtZW50cy5tZFwiLCBpbXBvcnQubWV0YS51cmwpLFxuICAgICAgXCJ1dGYtOFwiLFxuICAgICk7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUFJFRkVSRU5DRVMubWRcIiksXG4gICAgICBcIi0tLVxcbnBsYW5uaW5nX2RlcHRoOiBkZWVwXFxud29ya2Zsb3dfcHJlZnNfY2FwdHVyZWQ6IHRydWVcXG4tLS1cXG5cIixcbiAgICApO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJQUk9KRUNULm1kXCIpLCB2YWxpZFByb2plY3QpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJSRVFVSVJFTUVOVFMubWRcIiksIHZhbGlkUmVxdWlyZW1lbnRzKTtcbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiLCBcInJlc2VhcmNoLWRlY2lzaW9uLmpzb25cIiksICd7XCJkZWNpc2lvblwiOlwic2tpcFwifVxcbicpO1xuXG4gICAgZm9yIChjb25zdCBsZWdhY3kgb2YgW1wiUFJPSkVDVFwiLCBcIlJFU0VBUkNILVBST0pFQ1RcIiwgXCJXT1JLRkxPVy1QUkVGU1wiXSkge1xuICAgICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBsZWdhY3kpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBtZXNzYWdlczogdW5rbm93bltdID0gW107XG4gICAgYXdhaXQgc2hvd1NtYXJ0RW50cnkobWFrZUN0eChgbGVnYWN5LSR7cmFuZG9tVVVJRCgpfWApIGFzIGFueSwgbWFrZVBpKG1lc3NhZ2VzKSBhcyBhbnksIGJhc2UpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKG1lc3NhZ2VzLmxlbmd0aCwgMSwgXCJmaXJzdCByZWFsIG1pbGVzdG9uZSBkaXNjdXNzaW9uIHNob3VsZCBkaXNwYXRjaFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJQUk9KRUNUXCIpKSwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChleGlzdHNTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIlJFU0VBUkNILVBST0pFQ1RcIikpLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGV4aXN0c1N5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiV09SS0ZMT1ctUFJFRlNcIikpLCBmYWxzZSk7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHByZXZpb3VzV29ya2Zsb3dQYXRoID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUEFUSDtcbiAgICBlbHNlIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QQVRIID0gcHJldmlvdXNXb3JrZmxvd1BhdGg7XG4gICAgY2xlYXJQZW5kaW5nQXV0b1N0YXJ0KGJhc2UpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IGNsb3NlRGF0YWJhc2UgfSA9IGF3YWl0IGltcG9ydChcIi4uL2dzZC1kYi50c1wiKTtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGNhdGNoIHt9XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZWVwIHByb2plY3Qgc2V0dXA6IHByb2plY3QgcXVlc3Rpb24gcGF1c2VzIGluc3RlYWQgb2YgYXJ0aWZhY3QtcmV0cnlpbmdcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBzID0gbmV3IEF1dG9TZXNzaW9uKCk7XG4gICAgcy5hY3RpdmUgPSB0cnVlO1xuICAgIHMuYmFzZVBhdGggPSBiYXNlO1xuICAgIHMuY3VycmVudFVuaXQgPSB7IHR5cGU6IFwiZGlzY3Vzcy1wcm9qZWN0XCIsIGlkOiBcIlBST0pFQ1RcIiwgc3RhcnRlZEF0OiBEYXRlLm5vdygpIH07XG5cbiAgICBsZXQgcGF1c2VDYWxsZWQgPSBmYWxzZTtcbiAgICBjb25zdCBub3RpZmljYXRpb25zOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBvc3RVbml0UHJlVmVyaWZpY2F0aW9uKFxuICAgICAge1xuICAgICAgICBzLFxuICAgICAgICBjdHg6IHsgdWk6IHsgbm90aWZ5OiAobWVzc2FnZTogc3RyaW5nKSA9PiBub3RpZmljYXRpb25zLnB1c2gobWVzc2FnZSkgfSB9IGFzIGFueSxcbiAgICAgICAgcGk6IHt9IGFzIGFueSxcbiAgICAgICAgYnVpbGRTbmFwc2hvdE9wdHM6ICgpID0+ICh7fSkgYXMgYW55LFxuICAgICAgICBsb2NrQmFzZTogKCkgPT4gYmFzZSxcbiAgICAgICAgc3RvcEF1dG86IGFzeW5jICgpID0+IHt9LFxuICAgICAgICBwYXVzZUF1dG86IGFzeW5jICgpID0+IHsgcGF1c2VDYWxsZWQgPSB0cnVlOyB9LFxuICAgICAgICB1cGRhdGVQcm9ncmVzc1dpZGdldDogKCkgPT4ge30sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBza2lwU2V0dGxlRGVsYXk6IHRydWUsXG4gICAgICAgIHNraXBXb3JrdHJlZVN5bmM6IHRydWUsXG4gICAgICAgIGFnZW50RW5kTWVzc2FnZXM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICByb2xlOiBcImFzc2lzdGFudFwiLFxuICAgICAgICAgICAgY29udGVudDogW1xuICAgICAgICAgICAgICB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIldoYXQgZG8geW91IHdhbnQgdG8gYnVpbGQ/XFxuXFxuT3B0aW9uczpcXG4xLiBOZXcgYXBwXFxuMi4gRXhpc3RpbmcgYXBwXCIgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIFwiZGlzcGF0Y2hlZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocGF1c2VDYWxsZWQsIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChzLnBlbmRpbmdWZXJpZmljYXRpb25SZXRyeSwgbnVsbCk7XG4gICAgYXNzZXJ0LmVxdWFsKHMudmVyaWZpY2F0aW9uUmV0cnlDb3VudC5zaXplLCAwKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBub3RpZmljYXRpb25zLnNvbWUoKG1lc3NhZ2UpID0+IG1lc3NhZ2UuaW5jbHVkZXMoXCJ3YWl0aW5nIGZvciB5b3VyIGlucHV0XCIpKSxcbiAgICAgIFwic2hvdWxkIG5vdGlmeSB0aGF0IHRoZSBwcm9qZWN0IHVuaXQgaXMgd2FpdGluZyBmb3IgdXNlciBpbnB1dFwiLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZWVwIHByb2plY3Qgc2V0dXA6IHJlbW90ZSBxdWVzdGlvbiBmYWlsdXJlIGlzIHRyZWF0ZWQgYXMgd2FpdGluZyBmb3IgdXNlciBpbnB1dFwiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChcbiAgICBpc0F3YWl0aW5nVXNlcklucHV0KFtcbiAgICAgIHtcbiAgICAgICAgcm9sZTogXCJ0b29sUmVzdWx0XCIsXG4gICAgICAgIGNvbnRlbnQ6IFwiUmVtb3RlIHF1ZXN0aW9ucyBmYWlsZWQgKGRpc2NvcmQpOiBEaXNjb3JkIEFQSSBIVFRQIDQwMVwiLFxuICAgICAgfSxcbiAgICBdKSxcbiAgICB0cnVlLFxuICApO1xufSk7XG5cbnRlc3QoXCJkZWVwIHByb2plY3Qgc2V0dXA6IHVzZXIgcXVlc3Rpb24gZG9lcyBub3QgbWFzcXVlcmFkZSBhcyBhc3Npc3RhbnQgaW5wdXQgd2FpdFwiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChcbiAgICBpc0F3YWl0aW5nVXNlcklucHV0KFtcbiAgICAgIHtcbiAgICAgICAgcm9sZTogXCJ1c2VyXCIsXG4gICAgICAgIGNvbnRlbnQ6IFwiU2hvdWxkIHdlIHByb2NlZWQ/XCIsXG4gICAgICB9LFxuICAgIF0pLFxuICAgIGZhbHNlLFxuICApO1xufSk7XG5cbnRlc3QoXCJkZWVwIHByb2plY3Qgc2V0dXA6IHVzZXItcXVvdGVkIHJlbW90ZSBxdWVzdGlvbiBmYWlsdXJlIGRvZXMgbm90IHBhdXNlIGF1dG8tbW9kZVwiLCAoKSA9PiB7XG4gIGNvbnN0IG1lc3NhZ2VzID0gW1xuICAgIHtcbiAgICAgIHJvbGU6IFwidXNlclwiLFxuICAgICAgY29udGVudDogXCJUaGUgbG9nIHNhaWQ6IFJlbW90ZSBxdWVzdGlvbnMgZmFpbGVkIChkaXNjb3JkKTogRGlzY29yZCBBUEkgSFRUUCA0MDFcIixcbiAgICB9LFxuICBdO1xuXG4gIGFzc2VydC5lcXVhbChpc0F3YWl0aW5nVXNlcklucHV0KG1lc3NhZ2VzKSwgZmFsc2UpO1xuICBhc3NlcnQuZXF1YWwoc2hvdWxkUGF1c2VGb3JVc2VyQXBwcm92YWxRdWVzdGlvbihcImRpc2N1c3MtcHJvamVjdFwiLCBtZXNzYWdlcyksIGZhbHNlKTtcbn0pO1xuXG50ZXN0KFwiZGVlcCBwcm9qZWN0IHNldHVwOiBwbGFpbi10ZXh0IGFwcHJvdmFsIHdhaXQgaXMgdHJlYXRlZCBhcyB3YWl0aW5nIGZvciB1c2VyIGlucHV0XCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIGlzQXdhaXRpbmdVc2VySW5wdXQoW1xuICAgICAge1xuICAgICAgICByb2xlOiBcImFzc2lzdGFudFwiLFxuICAgICAgICBjb250ZW50OiBcIkdvb2QsIFBST0pFQ1QubWQgY29uZmlybXMgbG9jYWxTdG9yYWdlIGZvciBwZXJzaXN0ZW5jZS4gUmVxdWlyZW1lbnRzIGxvb2sgc29saWQuIFdhaXRpbmcgZm9yIHlvdXIgY29uZmlybWF0aW9uIGJlZm9yZSB3cml0aW5nLlwiLFxuICAgICAgfSxcbiAgICBdKSxcbiAgICB0cnVlLFxuICApO1xufSk7XG5cbnRlc3QoXCJkZWVwIHByb2plY3Qgc2V0dXA6IG9wZW5pbmcgaW50ZXJ2aWV3IHF1ZXN0aW9uIGRvZXMgbm90IHRyaWdnZXIgYXBwcm92YWwgYWJvcnRcIiwgKCkgPT4ge1xuICBjb25zdCBtZXNzYWdlcyA9IFtcbiAgICB7XG4gICAgICByb2xlOiBcImFzc2lzdGFudFwiLFxuICAgICAgY29udGVudDogXCJXaGF0IGRvIHlvdSB3YW50IHRvIGJ1aWxkP1wiLFxuICAgIH0sXG4gIF07XG5cbiAgYXNzZXJ0LmVxdWFsKGlzQXdhaXRpbmdVc2VySW5wdXQobWVzc2FnZXMpLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKHNob3VsZFBhdXNlRm9yVXNlckFwcHJvdmFsUXVlc3Rpb24oXCJkaXNjdXNzLXByb2plY3RcIiwgbWVzc2FnZXMpLCBmYWxzZSk7XG59KTtcblxudGVzdChcImRlZXAgcHJvamVjdCBzZXR1cDogZ3JvdW5kaW5nIGludGVydmlldyBxdWVzdGlvbiB3aXRoIHJlcXVpcmVtZW50cyBjb250ZXh0IGRvZXMgbm90IHRyaWdnZXIgYXBwcm92YWwgYWJvcnRcIiwgKCkgPT4ge1xuICBjb25zdCBtZXNzYWdlcyA9IFtcbiAgICB7XG4gICAgICByb2xlOiBcImFzc2lzdGFudFwiLFxuICAgICAgY29udGVudDogW1xuICAgICAgICBcIkkgd2lsbCB1c2UgdGhpcyB0byBkcmFmdCByZXF1aXJlbWVudHMuXCIsXG4gICAgICAgIFwiR3JvdW5kaW5nIHF1ZXN0aW9uOiBpcyB0aGlzIHB1cmVseSBsb2NhbC9vZmZsaW5lLCBvciBkbyB5b3Ugd2FudCB0YXNrcyB0byBwZXJzaXN0IGFjcm9zcyBicm93c2VyIHNlc3Npb25zL2RldmljZXMgKGxvY2FsIHN0b3JhZ2UgdnMuIGEgYmFja2VuZCk/XCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgfSxcbiAgXTtcblxuICBhc3NlcnQuZXF1YWwoaXNBd2FpdGluZ1VzZXJJbnB1dChtZXNzYWdlcyksIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoc2hvdWxkUGF1c2VGb3JVc2VyQXBwcm92YWxRdWVzdGlvbihcImRpc2N1c3MtcHJvamVjdFwiLCBtZXNzYWdlcyksIGZhbHNlKTtcbn0pO1xuXG50ZXN0KFwiZGVlcCBwcm9qZWN0IHNldHVwOiBwZXJzaXN0ZW5jZSBhbmQgYW50aS1nb2FscyBpbnRlcnZpZXcgcHJvbXB0IGRvZXMgbm90IHRyaWdnZXIgYXBwcm92YWwgYWJvcnRcIiwgKCkgPT4ge1xuICBjb25zdCBtZXNzYWdlcyA9IFtcbiAgICB7XG4gICAgICByb2xlOiBcImFzc2lzdGFudFwiLFxuICAgICAgY29udGVudDogW1xuICAgICAgICBcIkdyZWVuZmllbGQsIHBlcnNvbmFsLCBwbGFpbiBIVE1ML0NTUy9KUywgY29yZSB2YWx1ZSBpcyBjcmVhdGUgYW5kIGNoZWNrIG9mZiB0YXNrcy5cIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCJBIGNvdXBsZSBtb3JlOlwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIjEuIFBlcnNpc3RlbmNlPyBTaG91bGQgdGFza3Mgc3Vydml2ZSBhIHBhZ2UgcmVmcmVzaCAobG9jYWxTdG9yYWdlKSwgb3IgaXMgaXQgZmluZSBpZiB0aGV5IHJlc2V0IG9uIHJlbG9hZD9cIixcbiAgICAgICAgXCIyLiBBbnRpLWdvYWxzIC0gd2hhdCB3b3VsZCB5b3UgZXhwbGljaXRseSBub3Qgd2FudD8gKGUuZy4sIG5vIHVzZXIgYWNjb3VudHMsIG5vIGJhY2tlbmQsIG5vIGNhdGVnb3JpZXMvdGFncywgbm8gZHVlIGRhdGVzIC0gb3Igc29tZXRoaW5nIGVsc2UpXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgfSxcbiAgXTtcblxuICBhc3NlcnQuZXF1YWwoaXNBd2FpdGluZ1VzZXJJbnB1dChtZXNzYWdlcyksIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoc2hvdWxkUGF1c2VGb3JVc2VyQXBwcm92YWxRdWVzdGlvbihcImRpc2N1c3MtcHJvamVjdFwiLCBtZXNzYWdlcyksIGZhbHNlKTtcbn0pO1xuXG50ZXN0KFwiZGVlcCBwcm9qZWN0IHNldHVwOiBkaXNjb3ZlcnkgcXVlc3Rpb25zIGJlZm9yZSB3cml0aW5nIFBST0pFQ1QgZG8gbm90IHRyaWdnZXIgYXBwcm92YWwgYWJvcnRcIiwgKCkgPT4ge1xuICBjb25zdCBtZXNzYWdlcyA9IFtcbiAgICB7XG4gICAgICByb2xlOiBcImFzc2lzdGFudFwiLFxuICAgICAgY29udGVudDogW1xuICAgICAgICBcIkdvb2QuIEdyZWVuZmllbGQgSFRNTC9DU1MvSlMgdG8tZG8gYXBwLCBwZXJzb25hbCB1c2UsIGNvcmUgZmVhdHVyZSBpcyBjcmVhdGUgYW5kIGNoZWNrIG9mZiB0YXNrcy5cIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCJUd28gbW9yZSBxdWVzdGlvbnMgYmVmb3JlIEkgd3JpdGUgUFJPSkVDVC5tZDpcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIxLiBBbnkgcGVyc2lzdGVuY2U/IFNob3VsZCB0YXNrcyBzdXJ2aXZlIGEgcGFnZSByZWZyZXNoIC0gbG9jYWxTdG9yYWdlLCBvciBpcyBpbi1tZW1vcnkgZmluZSBmb3Igbm93P1wiLFxuICAgICAgICBcIjIuIFJvdWdoIG1pbGVzdG9uZSBzaGFwZT8gSXMgTTAwMSBcXFwiYmFzaWMgY3JlYXRlL2NvbXBsZXRlIGxpc3QgdGhhdCB3b3JrcyBpbiBhIGJyb3dzZXIsXFxcIiBvciBkbyB5b3UgaGF2ZSBhIHYyIGluIG1pbmQgKGUuZy4sIGVkaXQvZGVsZXRlLCBkdWUgZGF0ZXMsIGNhdGVnb3JpZXMpP1wiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgIH0sXG4gIF07XG5cbiAgYXNzZXJ0LmVxdWFsKGlzQXdhaXRpbmdVc2VySW5wdXQobWVzc2FnZXMpLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKHNob3VsZFBhdXNlRm9yVXNlckFwcHJvdmFsUXVlc3Rpb24oXCJkaXNjdXNzLXByb2plY3RcIiwgbWVzc2FnZXMpLCBmYWxzZSk7XG59KTtcblxudGVzdChcImRlZXAgcHJvamVjdCBzZXR1cDogZGlzY292ZXJ5IHF1ZXN0aW9uIG1lbnRpb25pbmcgd3JpdGUgaW50ZW50IGRvZXMgbm90IHRyaWdnZXIgYXBwcm92YWwgYWJvcnRcIiwgKCkgPT4ge1xuICBjb25zdCBtZXNzYWdlcyA9IFtcbiAgICB7XG4gICAgICByb2xlOiBcImFzc2lzdGFudFwiLFxuICAgICAgY29udGVudDogXCJCZWZvcmUgSSB3cml0ZSBQUk9KRUNULCBhbnkgcGVyc2lzdGVuY2U/XCIsXG4gICAgfSxcbiAgXTtcblxuICBhc3NlcnQuZXF1YWwoaXNBd2FpdGluZ1VzZXJJbnB1dChtZXNzYWdlcyksIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoc2hvdWxkUGF1c2VGb3JVc2VyQXBwcm92YWxRdWVzdGlvbihcImRpc2N1c3MtcHJvamVjdFwiLCBtZXNzYWdlcyksIGZhbHNlKTtcbn0pO1xuXG50ZXN0KFwiZGVlcCBwcm9qZWN0IHNldHVwOiBzY29wZSBkaXNjb3ZlcnkgcXVlc3Rpb24gbWVudGlvbmluZyBhZGQgZG9lcyBub3QgdHJpZ2dlciBhcHByb3ZhbCBhYm9ydFwiLCAoKSA9PiB7XG4gIGNvbnN0IG1lc3NhZ2VzID0gW1xuICAgIHtcbiAgICAgIHJvbGU6IFwiYXNzaXN0YW50XCIsXG4gICAgICBjb250ZW50OiBcIlNob3VsZCB0aGUgYmFzaWMgbWlsZXN0b25lIGFkZCBkZWxldGUgc3VwcG9ydCwgb3Iga2VlcCBkZWxldGUgZm9yIGEgbGF0ZXIgdjI/XCIsXG4gICAgfSxcbiAgXTtcblxuICBhc3NlcnQuZXF1YWwoaXNBd2FpdGluZ1VzZXJJbnB1dChtZXNzYWdlcyksIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoc2hvdWxkUGF1c2VGb3JVc2VyQXBwcm92YWxRdWVzdGlvbihcImRpc2N1c3MtcHJvamVjdFwiLCBtZXNzYWdlcyksIGZhbHNlKTtcbn0pO1xuXG50ZXN0KFwiZGVlcCBwcm9qZWN0IHNldHVwOiByZXF1aXJlbWVudHMgcHJldmlldyBxdWVzdGlvbiBmcm9tIHNjcmVlbnNob3QgaXMgdHJlYXRlZCBhcyB3YWl0aW5nXCIsICgpID0+IHtcbiAgY29uc3QgbWVzc2FnZXMgPSBbXG4gICAge1xuICAgICAgcm9sZTogXCJhc3Npc3RhbnRcIixcbiAgICAgIGNvbnRlbnQ6IFtcbiAgICAgICAgXCJQcm9wb3NlZCByZXF1aXJlbWVudHM6XCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwifCBJRCB8IFRpdGxlIHwgQ2xhc3MgfCBTdGF0dXMgfCBPd25lciB8IFNvdXJjZSB8XCIsXG4gICAgICAgIFwifCAtLS0gfCAtLS0gfCAtLS0gfCAtLS0gfCAtLS0gfCAtLS0gfFwiLFxuICAgICAgICBcInwgUjAwMSB8IFVzZXIgY2FuIGFkZCBhIHRhc2sgfCBwcmltYXJ5LXVzZXItbG9vcCB8IGFjdGl2ZSB8IE0wMDEvbm9uZSB5ZXQgfCB1c2VyIHxcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCJEb2VzIHRoaXMgbG9vayByaWdodD8gQW55dGhpbmcgdG8gYWRkLCByZW1vdmUsIG9yIHJlY2xhc3NpZnk/XCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgfSxcbiAgXTtcblxuICBhc3NlcnQuZXF1YWwoaXNBd2FpdGluZ1VzZXJJbnB1dChtZXNzYWdlcyksIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoc2hvdWxkUGF1c2VGb3JVc2VyQXBwcm92YWxRdWVzdGlvbihcImRpc2N1c3MtcmVxdWlyZW1lbnRzXCIsIG1lc3NhZ2VzKSwgdHJ1ZSk7XG59KTtcblxudGVzdChcImRlZXAgcHJvamVjdCBzZXR1cDogcmVzZWFyY2ggZGVjaXNpb24gcXVlc3Rpb24gdHJpZ2dlcnMgYXBwcm92YWwgYm91bmRhcnkgcGF1c2VcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoXG4gICAgc2hvdWxkUGF1c2VGb3JVc2VyQXBwcm92YWxRdWVzdGlvbihcInJlc2VhcmNoLWRlY2lzaW9uXCIsIFtcbiAgICAgIHtcbiAgICAgICAgcm9sZTogXCJhc3Npc3RhbnRcIixcbiAgICAgICAgY29udGVudDogXCJSdW4gZG9tYWluIHJlc2VhcmNoIG5vdz8gKHkvbilcIixcbiAgICAgIH0sXG4gICAgXSksXG4gICAgdHJ1ZSxcbiAgKTtcbn0pO1xuXG50ZXN0KFwiZGVlcCBwcm9qZWN0IHNldHVwOiBwbGFpbi10ZXh0IGFwcHJvdmFsIHF1ZXN0aW9ucyBtYXAgdG8gd3JpdGUtZ2F0ZSBpZHNcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoYXBwcm92YWxHYXRlSWRGb3JVbml0KFwiZGlzY3Vzcy1wcm9qZWN0XCIsIFwiUFJPSkVDVFwiKSwgXCJkZXB0aF92ZXJpZmljYXRpb25fcHJvamVjdF9jb25maXJtXCIpO1xuICBhc3NlcnQuZXF1YWwoYXBwcm92YWxHYXRlSWRGb3JVbml0KFwiZGlzY3Vzcy1yZXF1aXJlbWVudHNcIiwgXCJSRVFVSVJFTUVOVFNcIiksIFwiZGVwdGhfdmVyaWZpY2F0aW9uX3JlcXVpcmVtZW50c19jb25maXJtXCIpO1xuICBhc3NlcnQuZXF1YWwoYXBwcm92YWxHYXRlSWRGb3JVbml0KFwiZGlzY3Vzcy1taWxlc3RvbmVcIiwgXCJNMDAxXCIpLCBcImRlcHRoX3ZlcmlmaWNhdGlvbl9NMDAxX2NvbmZpcm1cIik7XG4gIGFzc2VydC5lcXVhbChhcHByb3ZhbEdhdGVJZEZvclVuaXQoXCJyZXNlYXJjaC1kZWNpc2lvblwiLCBcIlJFU0VBUkNILURFQ0lTSU9OXCIpLCBcImRlcHRoX3ZlcmlmaWNhdGlvbl9yZXNlYXJjaF9kZWNpc2lvbl9jb25maXJtXCIpO1xufSk7XG5cbnRlc3QoXCJkZWVwIHByb2plY3Qgc2V0dXA6IHBsYWluLXRleHQgYXBwcm92YWwgZ2F0ZSBjbGVhcnMgb25seSBvbiBleHBsaWNpdCBhcHByb3ZhbFwiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChpc0V4cGxpY2l0QXBwcm92YWxSZXNwb25zZShcInllcywgbG9va3MgZ29vZFwiKSwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChpc0V4cGxpY2l0QXBwcm92YWxSZXNwb25zZShcImdvIGFoZWFkIGFuZCB3cml0ZSBpdFwiKSwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChpc0V4cGxpY2l0QXBwcm92YWxSZXNwb25zZShcInllcywgYWRkIGRlbGV0ZSBzdXBwb3J0IGZpcnN0XCIpLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbChpc0V4cGxpY2l0QXBwcm92YWxSZXNwb25zZShcIm5vdCBxdWl0ZSwgcmVtb3ZlIHRoZSBkdWUgZGF0ZVwiKSwgZmFsc2UpO1xuICBhc3NlcnQuZXF1YWwoaXNFeHBsaWNpdEFwcHJvdmFsUmVzcG9uc2UoXCJyZXNlYXJjaFwiLCBcImRlcHRoX3ZlcmlmaWNhdGlvbl9yZXNlYXJjaF9kZWNpc2lvbl9jb25maXJtXCIpLCB0cnVlKTtcbn0pO1xuXG50ZXN0KFwiZGVlcCBwcm9qZWN0IHNldHVwOiBkaXNjdXNzLW1pbGVzdG9uZSBxdWVzdGlvbiBmYWlsdXJlIHBhdXNlcyBpbnN0ZWFkIG9mIGFydGlmYWN0LXJldHJ5aW5nXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcyA9IG5ldyBBdXRvU2Vzc2lvbigpO1xuICAgIHMuYWN0aXZlID0gdHJ1ZTtcbiAgICBzLmJhc2VQYXRoID0gYmFzZTtcbiAgICBzLmN1cnJlbnRVbml0ID0geyB0eXBlOiBcImRpc2N1c3MtbWlsZXN0b25lXCIsIGlkOiBcIlBST0pFQ1RcIiwgc3RhcnRlZEF0OiBEYXRlLm5vdygpIH07XG5cbiAgICBsZXQgcGF1c2VDYWxsZWQgPSBmYWxzZTtcbiAgICBjb25zdCBub3RpZmljYXRpb25zOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBvc3RVbml0UHJlVmVyaWZpY2F0aW9uKFxuICAgICAge1xuICAgICAgICBzLFxuICAgICAgICBjdHg6IHsgdWk6IHsgbm90aWZ5OiAobWVzc2FnZTogc3RyaW5nKSA9PiBub3RpZmljYXRpb25zLnB1c2gobWVzc2FnZSkgfSB9IGFzIGFueSxcbiAgICAgICAgcGk6IHt9IGFzIGFueSxcbiAgICAgICAgYnVpbGRTbmFwc2hvdE9wdHM6ICgpID0+ICh7fSkgYXMgYW55LFxuICAgICAgICBsb2NrQmFzZTogKCkgPT4gYmFzZSxcbiAgICAgICAgc3RvcEF1dG86IGFzeW5jICgpID0+IHt9LFxuICAgICAgICBwYXVzZUF1dG86IGFzeW5jICgpID0+IHsgcGF1c2VDYWxsZWQgPSB0cnVlOyB9LFxuICAgICAgICB1cGRhdGVQcm9ncmVzc1dpZGdldDogKCkgPT4ge30sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBza2lwU2V0dGxlRGVsYXk6IHRydWUsXG4gICAgICAgIHNraXBXb3JrdHJlZVN5bmM6IHRydWUsXG4gICAgICAgIGFnZW50RW5kTWVzc2FnZXM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICByb2xlOiBcInRvb2xSZXN1bHRcIixcbiAgICAgICAgICAgIGNvbnRlbnQ6IFwiUmVtb3RlIHF1ZXN0aW9ucyBmYWlsZWQgKGRpc2NvcmQpOiBEaXNjb3JkIEFQSSBIVFRQIDQwMVwiLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgICk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBcImRpc3BhdGNoZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHBhdXNlQ2FsbGVkLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwocy5wZW5kaW5nVmVyaWZpY2F0aW9uUmV0cnksIG51bGwpO1xuICAgIGFzc2VydC5lcXVhbChzLnZlcmlmaWNhdGlvblJldHJ5Q291bnQuc2l6ZSwgMCk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgbm90aWZpY2F0aW9ucy5zb21lKChtZXNzYWdlKSA9PiBtZXNzYWdlLmluY2x1ZGVzKFwid2FpdGluZyBmb3IgeW91ciBpbnB1dFwiKSksXG4gICAgICBcInNob3VsZCBub3RpZnkgdGhhdCB0aGUgZGlzY3VzcyB1bml0IGlzIHdhaXRpbmcgZm9yIHVzZXIgaW5wdXRcIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwidmVyaWZpZWQgdGFzayBnaXQgY2xvc2VvdXQgZmFpbHVyZSByZXRyaWVzIGFuZCBjb250aW51ZXMgYXV0by1tb2RlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIHRyeSB7XG4gICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImluaXRcIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY29uZmlnXCIsIFwidXNlci5lbWFpbFwiLCBcInRlc3RAZXhhbXBsZS5jb21cIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY29uZmlnXCIsIFwidXNlci5uYW1lXCIsIFwiVGVzdCBVc2VyXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gICAgY29uc3QgaG9va1BhdGggPSBqb2luKGJhc2UsIFwiLmdpdFwiLCBcImhvb2tzXCIsIFwicHJlLWNvbW1pdFwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgaG9va1BhdGgsXG4gICAgICBbXG4gICAgICAgIFwiIyEvYmluL3NoXCIsXG4gICAgICAgIFwiY291bnRfZmlsZT0uZ2l0L3ByZS1jb21taXQtY291bnRcIixcbiAgICAgICAgXCJjb3VudD0wXCIsXG4gICAgICAgIFwiaWYgWyAtZiBcXFwiJGNvdW50X2ZpbGVcXFwiIF07IHRoZW4gY291bnQ9JChjYXQgXFxcIiRjb3VudF9maWxlXFxcIik7IGZpXCIsXG4gICAgICAgIFwiY291bnQ9JCgoY291bnQgKyAxKSlcIixcbiAgICAgICAgXCJwcmludGYgXFxcIiVzXFxcIiBcXFwiJGNvdW50XFxcIiA+IFxcXCIkY291bnRfZmlsZVxcXCJcIixcbiAgICAgICAgXCJlY2hvIGJsb2NrZWQgYnkgdGVzdCBob29rID4mMlwiLFxuICAgICAgICBcImV4aXQgMVwiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICk7XG4gICAgY2htb2RTeW5jKGhvb2tQYXRoLCAwbzc1NSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwid29yay50eHRcIiksIFwiY2hhbmdlZFxcblwiKTtcblxuICAgIGNvbnN0IHMgPSBuZXcgQXV0b1Nlc3Npb24oKTtcbiAgICBzLmFjdGl2ZSA9IHRydWU7XG4gICAgcy5iYXNlUGF0aCA9IGJhc2U7XG4gICAgcy5vcmlnaW5hbEJhc2VQYXRoID0gYmFzZTtcbiAgICBzLmN1cnJlbnRVbml0ID0geyB0eXBlOiBcImV4ZWN1dGUtdGFza1wiLCBpZDogXCJNMDAxL1MwMS9UMDFcIiwgc3RhcnRlZEF0OiBEYXRlLm5vdygpIH07XG5cbiAgICBsZXQgcGF1c2VDYWxsZWQgPSBmYWxzZTtcbiAgICBjb25zdCBub3RpZmljYXRpb25zOiBBcnJheTx7IG1lc3NhZ2U6IHN0cmluZzsgc2V2ZXJpdHk/OiBzdHJpbmcgfT4gPSBbXTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwb3N0VW5pdFBvc3RWZXJpZmljYXRpb24oe1xuICAgICAgcyxcbiAgICAgIGN0eDogeyB1aTogeyBub3RpZnk6IChtZXNzYWdlOiBzdHJpbmcsIHNldmVyaXR5Pzogc3RyaW5nKSA9PiBub3RpZmljYXRpb25zLnB1c2goeyBtZXNzYWdlLCBzZXZlcml0eSB9KSB9IH0gYXMgYW55LFxuICAgICAgcGk6IHt9IGFzIGFueSxcbiAgICAgIGJ1aWxkU25hcHNob3RPcHRzOiAoKSA9PiAoe30pIGFzIGFueSxcbiAgICAgIGxvY2tCYXNlOiAoKSA9PiBiYXNlLFxuICAgICAgc3RvcEF1dG86IGFzeW5jICgpID0+IHt9LFxuICAgICAgcGF1c2VBdXRvOiBhc3luYyAoKSA9PiB7IHBhdXNlQ2FsbGVkID0gdHJ1ZTsgfSxcbiAgICAgIHVwZGF0ZVByb2dyZXNzV2lkZ2V0OiAoKSA9PiB7fSxcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIFwiY29udGludWVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHBhdXNlQ2FsbGVkLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHMubGFzdEdpdEFjdGlvblN0YXR1cywgXCJmYWlsZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlYWRGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdpdFwiLCBcInByZS1jb21taXQtY291bnRcIiksIFwidXRmLThcIiksIFwiM1wiKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBub3RpZmljYXRpb25zLnNvbWUoKGVudHJ5KSA9PiBlbnRyeS5zZXZlcml0eSA9PT0gXCJ3YXJuaW5nXCIgJiYgZW50cnkubWVzc2FnZS5pbmNsdWRlcyhcIkdpdCBjb21taXQgZmFpbGVkXCIpKSxcbiAgICAgIFwidmVyaWZpZWQgdGFzayBnaXQgY2xvc2VvdXQgZmFpbHVyZSBzaG91bGQgd2FybiBpbnN0ZWFkIG9mIHN0b3BwaW5nIGF1dG8tbW9kZVwiLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZWVwIHByb2plY3Qgc2V0dXA6IGFwcHJvdmFsIHdhaXQgd2lucyBvdmVyIGRldGVybWluaXN0aWMgd3JpdGUtZ2F0ZSBwbGFjZWhvbGRlclwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICB0cnkge1xuICAgIGNvbnN0IHMgPSBuZXcgQXV0b1Nlc3Npb24oKTtcbiAgICBzLmFjdGl2ZSA9IHRydWU7XG4gICAgcy5iYXNlUGF0aCA9IGJhc2U7XG4gICAgcy5jdXJyZW50VW5pdCA9IHsgdHlwZTogXCJkaXNjdXNzLXJlcXVpcmVtZW50c1wiLCBpZDogXCJSRVFVSVJFTUVOVFNcIiwgc3RhcnRlZEF0OiBEYXRlLm5vdygpIH07XG4gICAgcy5sYXN0VG9vbEludm9jYXRpb25FcnJvciA9IFwiZ3NkX3N1bW1hcnlfc2F2ZTogRXJyb3Igc2F2aW5nIGFydGlmYWN0OiByb290X2FydGlmYWN0X3dyaXRlX2Jsb2NrZWRcIjtcbiAgICBzLnZlcmlmaWNhdGlvblJldHJ5Q291bnQuc2V0KFwiZGlzY3Vzcy1yZXF1aXJlbWVudHM6UkVRVUlSRU1FTlRTXCIsIDIpO1xuXG4gICAgbGV0IHBhdXNlQ2FsbGVkID0gZmFsc2U7XG4gICAgY29uc3Qgbm90aWZpY2F0aW9uczogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwb3N0VW5pdFByZVZlcmlmaWNhdGlvbihcbiAgICAgIHtcbiAgICAgICAgcyxcbiAgICAgICAgY3R4OiB7IHVpOiB7IG5vdGlmeTogKG1lc3NhZ2U6IHN0cmluZykgPT4gbm90aWZpY2F0aW9ucy5wdXNoKG1lc3NhZ2UpIH0gfSBhcyBhbnksXG4gICAgICAgIHBpOiB7fSBhcyBhbnksXG4gICAgICAgIGJ1aWxkU25hcHNob3RPcHRzOiAoKSA9PiAoe30pIGFzIGFueSxcbiAgICAgICAgbG9ja0Jhc2U6ICgpID0+IGJhc2UsXG4gICAgICAgIHN0b3BBdXRvOiBhc3luYyAoKSA9PiB7fSxcbiAgICAgICAgcGF1c2VBdXRvOiBhc3luYyAoKSA9PiB7IHBhdXNlQ2FsbGVkID0gdHJ1ZTsgfSxcbiAgICAgICAgdXBkYXRlUHJvZ3Jlc3NXaWRnZXQ6ICgpID0+IHt9LFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgc2tpcFNldHRsZURlbGF5OiB0cnVlLFxuICAgICAgICBza2lwV29ya3RyZWVTeW5jOiB0cnVlLFxuICAgICAgICBhZ2VudEVuZE1lc3NhZ2VzOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgcm9sZTogXCJhc3Npc3RhbnRcIixcbiAgICAgICAgICAgIGNvbnRlbnQ6IFwiUmVxdWlyZW1lbnRzIGxvb2sgc29saWQuIFdhaXRpbmcgZm9yIHlvdXIgY29uZmlybWF0aW9uIGJlZm9yZSB3cml0aW5nLlwiLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgICk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBcImRpc3BhdGNoZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHBhdXNlQ2FsbGVkLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwocy5sYXN0VG9vbEludm9jYXRpb25FcnJvciwgbnVsbCk7XG4gICAgYXNzZXJ0LmVxdWFsKGV4aXN0c1N5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJSRVFVSVJFTUVOVFMubWRcIikpLCBmYWxzZSk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgbm90aWZpY2F0aW9ucy5zb21lKChtZXNzYWdlKSA9PiBtZXNzYWdlLmluY2x1ZGVzKFwid2FpdGluZyBmb3IgeW91ciBpbnB1dFwiKSksXG4gICAgICBcInNob3VsZCBwYXVzZSBvbiB0aGUgdXNlciB3YWl0IGluc3RlYWQgb2Ygd3JpdGluZyBhIGJsb2NrZXIgcGxhY2Vob2xkZXJcIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsWUFBWSxXQUFXLGNBQWMsY0FBYyxRQUFRLHFCQUFxQjtBQUNwRyxTQUFTLG9CQUFvQjtBQUM3QixTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsa0JBQWtCO0FBRTNCLFNBQVMsYUFBYSxzQkFBc0I7QUFDNUMsU0FBUyxtQkFBbUI7QUFDNUIsU0FBUyxzQ0FBc0M7QUFDL0MsU0FBUyw0QkFBNEI7QUFDckMsU0FBUywwQkFBMEIsK0JBQStCO0FBQ2xFLFNBQVMsaUJBQWlCLDhDQUE4QztBQUN4RSxTQUFTLDZCQUE2Qix3QkFBd0IsK0JBQStCO0FBQzdGLFNBQVMsc0NBQXNDO0FBQy9DLFNBQVMscUJBQXFCO0FBQzlCLFNBQVMsdUJBQXVCLHFCQUFxQiw0QkFBNEIsMENBQTBDO0FBQzNIO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUlQLFNBQVMsV0FBbUI7QUFDMUIsUUFBTSxPQUFPLEtBQUssT0FB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
