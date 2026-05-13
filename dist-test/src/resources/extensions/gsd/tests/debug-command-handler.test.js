import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleDebug, parseDebugCommand } from "../commands-debug.js";
import { createDebugSession, debugSessionArtifactPath, updateDebugSession } from "../debug-session-store.js";
import { loadPrompt } from "../prompt-loader.js";
function makeBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-debug-command-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}
function createMockCtx() {
  const notifications = [];
  return {
    notifications,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      }
    }
  };
}
describe("parseDebugCommand", () => {
  test("supports strict subcommands and issue-start fallback", () => {
    assert.deepEqual(parseDebugCommand("list"), { type: "list" });
    assert.deepEqual(parseDebugCommand("status auth-flake"), { type: "status", slug: "auth-flake" });
    assert.deepEqual(parseDebugCommand("continue auth-flake"), { type: "continue", slug: "auth-flake" });
    assert.deepEqual(parseDebugCommand("--diagnose"), { type: "diagnose" });
  });
  test("treats ambiguous reserved-word phrases as issue text unless strict syntax matches", () => {
    assert.deepEqual(parseDebugCommand("status login fails on safari"), {
      type: "issue-start",
      issue: "status login fails on safari"
    });
    assert.deepEqual(parseDebugCommand("continue flaky checkout flow"), {
      type: "issue-start",
      issue: "continue flaky checkout flow"
    });
    assert.deepEqual(parseDebugCommand("list broken retry behavior"), {
      type: "issue-start",
      issue: "list broken retry behavior"
    });
  });
  test("returns actionable errors for malformed subcommand invocations", () => {
    assert.equal(parseDebugCommand("status").type, "error");
    assert.equal(parseDebugCommand("continue").type, "error");
    assert.equal(parseDebugCommand("--diagnose not/a-slug").type, "error");
    assert.equal(parseDebugCommand("--wat").type, "error");
  });
  test("routes multi-token --diagnose to diagnose-issue with root-cause-only intent", () => {
    assert.deepEqual(parseDebugCommand("--diagnose login fails on safari"), {
      type: "diagnose-issue",
      issue: "login fails on safari"
    });
    assert.deepEqual(parseDebugCommand("--diagnose flaky checkout flow"), {
      type: "diagnose-issue",
      issue: "flaky checkout flow"
    });
    assert.deepEqual(parseDebugCommand("--diagnose status is returning 500"), {
      type: "diagnose-issue",
      issue: "status is returning 500"
    });
  });
  test("--diagnose with valid slug remains slug-targeted diagnose", () => {
    assert.deepEqual(parseDebugCommand("--diagnose auth-flake"), {
      type: "diagnose",
      slug: "auth-flake"
    });
    assert.deepEqual(parseDebugCommand("--diagnose ci-flake-2"), {
      type: "diagnose",
      slug: "ci-flake-2"
    });
  });
  test("--diagnose with no args returns store-health diagnose", () => {
    assert.deepEqual(parseDebugCommand("--diagnose"), { type: "diagnose" });
  });
  test("single invalid slug token after --diagnose is an error not issue-start", () => {
    assert.equal(parseDebugCommand("--diagnose not/a-slug").type, "error");
    assert.equal(parseDebugCommand("--diagnose UPPERCASE").type, "error");
    assert.equal(parseDebugCommand("--diagnose has space").type, "diagnose-issue");
  });
  test("issue text starting with reserved words falls through to issue-start", () => {
    assert.deepEqual(parseDebugCommand("list broken retry behavior"), {
      type: "issue-start",
      issue: "list broken retry behavior"
    });
    assert.deepEqual(parseDebugCommand("status login is flaky"), {
      type: "issue-start",
      issue: "status login is flaky"
    });
    assert.deepEqual(parseDebugCommand("continue flaky checkout flow"), {
      type: "issue-start",
      issue: "continue flaky checkout flow"
    });
  });
});
describe("handleDebug lifecycle", () => {
  test("creates new session and persists mode/phase metadata", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const saved = process.cwd();
    process.chdir(base);
    try {
      await handleDebug("Login fails on Safari", ctx);
      assert.equal(ctx.notifications.length, 1);
      const note = ctx.notifications[0];
      assert.equal(note.level, "info");
      assert.match(note.message, /Debug session started: login-fails-on-safari/);
      assert.match(note.message, /mode=debug/);
      assert.match(note.message, /phase=queued/);
      const artifact = debugSessionArtifactPath(base, "login-fails-on-safari");
      const statusCtx = createMockCtx();
      await handleDebug("status login-fails-on-safari", statusCtx);
      assert.match(statusCtx.notifications[0].message, new RegExp(artifact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(statusCtx.notifications[0].message, /status=active/);
      assert.match(statusCtx.notifications[0].message, /phase=queued/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("issue-start dispatches a find_and_fix debug runner after creating the session", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const dispatched = [];
    const mockPi = {
      sendMessage(msg, options) {
        dispatched.push({ msg, options });
      }
    };
    const saved = process.cwd();
    process.chdir(base);
    try {
      await handleDebug("Login fails on Safari", ctx, mockPi);
      assert.equal(ctx.notifications[0].level, "info");
      assert.match(ctx.notifications[0].message, /Debug session started: login-fails-on-safari/);
      assert.match(ctx.notifications[0].message, /dispatchMode=find_and_fix/);
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0].msg.customType, "gsd-debug-start");
      assert.equal(dispatched[0].msg.display, false);
      assert.equal(dispatched[0].options.triggerTurn, true);
      assert.match(dispatched[0].msg.content, /`find_and_fix`/);
      assert.match(dispatched[0].msg.content, /login-fails-on-safari/);
      assert.match(dispatched[0].msg.content, /Login fails on Safari/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("list shows persisted session summaries with lifecycle metadata", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const saved = process.cwd();
    process.chdir(base);
    try {
      createDebugSession(base, { issue: "Auth timeout", createdAt: 10 });
      createDebugSession(base, { issue: "Billing webhook", createdAt: 20 });
      await handleDebug("list", ctx);
      assert.equal(ctx.notifications.length, 1);
      const note = ctx.notifications[0].message;
      assert.match(note, /Debug sessions:/);
      assert.match(note, /mode=debug status=active phase=queued/);
      assert.match(note, /auth-timeout/);
      assert.match(note, /billing-webhook/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("continue updates session lifecycle state", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const saved = process.cwd();
    process.chdir(base);
    try {
      createDebugSession(base, { issue: "CI flake", createdAt: 10, status: "paused", phase: "blocked" });
      await handleDebug("continue ci-flake", ctx);
      assert.equal(ctx.notifications.length, 1);
      const note = ctx.notifications[0].message;
      assert.match(note, /Resumed debug session: ci-flake/);
      assert.match(note, /status=active/);
      assert.match(note, /phase=continued/);
      const statusCtx = createMockCtx();
      await handleDebug("status ci-flake", statusCtx);
      assert.match(statusCtx.notifications[0].message, /status=active/);
      assert.match(statusCtx.notifications[0].message, /phase=continued/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("unknown slug and missing slug paths provide actionable warnings", async () => {
    const base = makeBase();
    const saved = process.cwd();
    process.chdir(base);
    try {
      const missingSlugCtx = createMockCtx();
      await handleDebug("status", missingSlugCtx);
      assert.equal(missingSlugCtx.notifications[0].level, "warning");
      assert.match(missingSlugCtx.notifications[0].message, /Missing slug/);
      const unknownSlugCtx = createMockCtx();
      await handleDebug("status no-such-session", unknownSlugCtx);
      assert.equal(unknownSlugCtx.notifications[0].level, "warning");
      assert.match(unknownSlugCtx.notifications[0].message, /Unknown debug session slug/);
      assert.match(unknownSlugCtx.notifications[0].message, /\/gsd debug list/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("detects malformed artifacts and surfaces remediation in list/diagnose", async () => {
    const base = makeBase();
    const saved = process.cwd();
    process.chdir(base);
    try {
      createDebugSession(base, { issue: "Healthy issue", createdAt: 1 });
      writeFileSync(join(base, ".gsd", "debug", "sessions", "broken.json"), "{ nope", "utf-8");
      const listCtx = createMockCtx();
      await handleDebug("list", listCtx);
      assert.match(listCtx.notifications[0].message, /Malformed artifacts: 1/);
      assert.match(listCtx.notifications[0].message, /Run \/gsd debug --diagnose/);
      const diagnoseCtx = createMockCtx();
      await handleDebug("--diagnose", diagnoseCtx);
      assert.equal(diagnoseCtx.notifications[0].level, "warning");
      assert.match(diagnoseCtx.notifications[0].message, /Malformed artifacts/);
      assert.match(diagnoseCtx.notifications[0].message, /Remediation:/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("reserved-word boundary condition still creates session when syntax is not strict", async () => {
    const base = makeBase();
    const saved = process.cwd();
    process.chdir(base);
    try {
      const ctx = createMockCtx();
      await handleDebug("status login is flaky on prod", ctx);
      assert.equal(ctx.notifications[0].level, "info");
      assert.match(ctx.notifications[0].message, /Debug session started:/);
      const slug = "status-login-is-flaky-on-prod";
      const statusCtx = createMockCtx();
      await handleDebug(`status ${slug}`, statusCtx);
      assert.equal(statusCtx.notifications[0].level, "info");
      assert.match(statusCtx.notifications[0].message, /mode=debug/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("--diagnose <issue text> creates diagnose session with mode=diagnose and find_root_cause_only dispatch", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const saved = process.cwd();
    process.chdir(base);
    try {
      await handleDebug("--diagnose login fails on safari", ctx);
      assert.equal(ctx.notifications.length, 1);
      const note = ctx.notifications[0];
      assert.equal(note.level, "info");
      assert.match(note.message, /Diagnose session started: login-fails-on-safari/);
      assert.match(note.message, /mode=diagnose/);
      assert.match(note.message, /dispatchMode=find_root_cause_only/);
      assert.match(note.message, /phase=queued/);
      assert.match(note.message, /status=active/);
      const statusCtx = createMockCtx();
      await handleDebug("status login-fails-on-safari", statusCtx);
      assert.match(statusCtx.notifications[0].message, /mode=diagnose/);
      assert.match(statusCtx.notifications[0].message, /status=active/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("--diagnose <slug> targets existing session for targeted diagnose", async () => {
    const base = makeBase();
    const saved = process.cwd();
    process.chdir(base);
    try {
      createDebugSession(base, { issue: "CI flake on main", createdAt: 1 });
      const ctx = createMockCtx();
      await handleDebug("--diagnose ci-flake-on-main", ctx);
      assert.equal(ctx.notifications.length, 1);
      assert.equal(ctx.notifications[0].level, "info");
      assert.match(ctx.notifications[0].message, /Diagnose session: ci-flake-on-main/);
      assert.match(ctx.notifications[0].message, /status=active/);
      assert.match(ctx.notifications[0].message, /malformedArtifactsInStore=0/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("--diagnose with unknown slug emits actionable warning", async () => {
    const base = makeBase();
    const saved = process.cwd();
    process.chdir(base);
    try {
      const ctx = createMockCtx();
      await handleDebug("--diagnose no-such-session", ctx);
      assert.equal(ctx.notifications[0].level, "warning");
      assert.match(ctx.notifications[0].message, /not found/);
      assert.match(ctx.notifications[0].message, /\/gsd debug list/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("diagnose-issue tolerates malformed artifact in store and still creates session", async () => {
    const base = makeBase();
    const saved = process.cwd();
    process.chdir(base);
    try {
      createDebugSession(base, { issue: "Healthy issue", createdAt: 1 });
      writeFileSync(join(base, ".gsd", "debug", "sessions", "broken.json"), "{ nope", "utf-8");
      const ctx = createMockCtx();
      await handleDebug("--diagnose billing webhook is dropping events", ctx);
      assert.equal(ctx.notifications[0].level, "info");
      assert.match(ctx.notifications[0].message, /Diagnose session started:/);
      assert.match(ctx.notifications[0].message, /mode=diagnose/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("continue blocks on resolved session with actionable warning", async () => {
    const base = makeBase();
    const saved = process.cwd();
    process.chdir(base);
    try {
      createDebugSession(base, { issue: "Done issue", createdAt: 1, status: "resolved", phase: "complete" });
      const ctx = createMockCtx();
      await handleDebug("continue done-issue", ctx);
      assert.equal(ctx.notifications[0].level, "warning");
      assert.match(ctx.notifications[0].message, /resolved/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("unknown flag returns error without silently routing to wrong path", async () => {
    const base = makeBase();
    const saved = process.cwd();
    process.chdir(base);
    try {
      const ctx = createMockCtx();
      await handleDebug("--unknown-flag some text", ctx);
      assert.equal(ctx.notifications[0].level, "warning");
      assert.match(ctx.notifications[0].message, /Unknown debug flag/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("diagnose-issue dispatches find_root_cause_only goal with slug and issue in payload", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const dispatched = [];
    const mockPi = {
      sendMessage(msg) {
        dispatched.push(msg);
      }
    };
    const saved = process.cwd();
    process.chdir(base);
    try {
      await handleDebug("--diagnose memory leak in worker pool", ctx, mockPi);
      assert.equal(ctx.notifications[0].level, "info");
      assert.match(ctx.notifications[0].message, /dispatchMode=find_root_cause_only/);
      assert.equal(dispatched.length, 1);
      const dispatch = dispatched[0];
      assert.equal(dispatch.customType, "gsd-debug-diagnose");
      assert.equal(dispatch.display, false);
      assert.match(dispatch.content, /`find_root_cause_only`/);
      assert.match(dispatch.content, /do \*\*NOT\*\* apply code changes/);
      assert.match(dispatch.content, /memory-leak-in-worker-pool/);
      assert.match(dispatch.content, /memory leak in worker pool/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("diagnose-issue dispatch never advertises fix-application in payload", async () => {
    const base = makeBase();
    const dispatched = [];
    const mockPi = {
      sendMessage(msg) {
        dispatched.push(msg);
      }
    };
    const saved = process.cwd();
    process.chdir(base);
    try {
      await handleDebug("--diagnose flaky checkout flow after payment", createMockCtx(), mockPi);
      assert.equal(dispatched.length, 1);
      assert.match(dispatched[0].content, /`find_root_cause_only`/);
      assert.match(dispatched[0].content, /do \*\*NOT\*\* apply code changes/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("continue dispatches find_and_fix goal scoped to the target slug only", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const dispatched = [];
    const mockPi = {
      sendMessage(msg) {
        dispatched.push(msg);
      }
    };
    const saved = process.cwd();
    process.chdir(base);
    try {
      createDebugSession(base, { issue: "Auth timeout", createdAt: 10, status: "paused", phase: "blocked" });
      createDebugSession(base, { issue: "Billing webhook", createdAt: 20, status: "paused", phase: "blocked" });
      await handleDebug("continue auth-timeout", ctx, mockPi);
      assert.match(ctx.notifications[0].message, /dispatchMode=find_and_fix/);
      assert.equal(dispatched.length, 1);
      const dispatch = dispatched[0];
      assert.equal(dispatch.customType, "gsd-debug-continue");
      assert.equal(dispatch.display, false);
      assert.match(dispatch.content, /`find_and_fix`/);
      assert.match(dispatch.content, /auth-timeout/);
      assert.doesNotMatch(dispatch.content, /billing-webhook/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("continue dispatch failure surfaces warning without corrupting session state", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const mockPi = {
      sendMessage() {
        throw new Error("transport unavailable");
      }
    };
    const saved = process.cwd();
    process.chdir(base);
    try {
      createDebugSession(base, { issue: "CI flake", createdAt: 10, status: "paused", phase: "blocked" });
      await handleDebug("continue ci-flake", ctx, mockPi);
      assert.match(ctx.notifications[0].message, /Resumed debug session/);
      assert.equal(ctx.notifications.length, 2);
      assert.equal(ctx.notifications[1].level, "warning");
      assert.match(ctx.notifications[1].message, /Continue dispatch failed/);
      assert.match(ctx.notifications[1].message, /ci-flake/);
      const statusCtx = createMockCtx();
      await handleDebug("status ci-flake", statusCtx);
      assert.match(statusCtx.notifications[0].message, /status=active/);
      assert.match(statusCtx.notifications[0].message, /phase=continued/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("diagnose-issue dispatch failure surfaces warning without losing session", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const mockPi = {
      sendMessage() {
        throw new Error("dispatch error");
      }
    };
    const saved = process.cwd();
    process.chdir(base);
    try {
      await handleDebug("--diagnose auth token expiry race condition", ctx, mockPi);
      assert.equal(ctx.notifications[0].level, "info");
      assert.match(ctx.notifications[0].message, /Diagnose session started/);
      assert.equal(ctx.notifications.length, 2);
      assert.equal(ctx.notifications[1].level, "warning");
      assert.match(ctx.notifications[1].message, /Diagnose dispatch failed/);
      assert.match(ctx.notifications[1].message, /auth-token-expiry-race-condition/);
      const statusCtx = createMockCtx();
      await handleDebug("status auth-token-expiry-race-condition", statusCtx);
      assert.equal(statusCtx.notifications[0].level, "info");
      assert.match(statusCtx.notifications[0].message, /mode=diagnose/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("continue with unknown slug emits warning without dispatching", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const dispatched = [];
    const mockPi = {
      sendMessage(msg) {
        dispatched.push(msg);
      }
    };
    const saved = process.cwd();
    process.chdir(base);
    try {
      await handleDebug("continue no-such-slug", ctx, mockPi);
      assert.equal(ctx.notifications[0].level, "warning");
      assert.match(ctx.notifications[0].message, /Unknown debug session slug/);
      assert.equal(dispatched.length, 0);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("diagnose-issue with issue text containing reserved command words dispatches correctly", async () => {
    const base = makeBase();
    const dispatched = [];
    const mockPi = {
      sendMessage(msg) {
        dispatched.push(msg);
      }
    };
    const saved = process.cwd();
    process.chdir(base);
    try {
      await handleDebug("--diagnose status endpoint continues to return 500", createMockCtx(), mockPi);
      assert.equal(dispatched.length, 1);
      assert.match(dispatched[0].content, /find_root_cause_only/);
      assert.match(dispatched[0].content, /status-endpoint-continues-to-return-500/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("continue with checkpoint state dispatches debug-session-manager template with checkpoint context", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const dispatched = [];
    const mockPi = {
      sendMessage(msg) {
        dispatched.push(msg);
      }
    };
    const saved = process.cwd();
    process.chdir(base);
    try {
      createDebugSession(base, { issue: "Auth timeout", createdAt: 10 });
      updateDebugSession(base, "auth-timeout", {
        checkpoint: {
          type: "human-verify",
          summary: "Confirm the network trace shows the right headers",
          awaitingResponse: true
        }
      });
      await handleDebug("continue auth-timeout", ctx, mockPi);
      assert.equal(dispatched.length, 1);
      const dispatch = dispatched[0];
      assert.equal(dispatch.customType, "gsd-debug-continue");
      assert.equal(dispatch.display, false);
      assert.match(dispatch.content, /## CHECKPOINT REACHED/);
      assert.match(dispatch.content, /## Active Checkpoint/);
      assert.match(dispatch.content, /type: human-verify/);
      assert.match(dispatch.content, /Confirm the network trace/);
      assert.match(ctx.notifications[0].message, /checkpointType=human-verify/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("continue with TDD gate pending dispatches find_root_cause_only and does not dispatch find_and_fix", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const dispatched = [];
    const mockPi = {
      sendMessage(msg) {
        dispatched.push(msg);
      }
    };
    const saved = process.cwd();
    process.chdir(base);
    try {
      createDebugSession(base, { issue: "Flaky auth", createdAt: 10 });
      updateDebugSession(base, "flaky-auth", {
        tddGate: { enabled: true, phase: "pending", testFile: "auth.test.ts" }
      });
      await handleDebug("continue flaky-auth", ctx, mockPi);
      assert.equal(dispatched.length, 1);
      const dispatch = dispatched[0];
      assert.match(dispatch.content, /## Goal\s+`find_root_cause_only`/);
      assert.doesNotMatch(dispatch.content, /## Goal\s+`find_and_fix`/);
      assert.match(dispatch.content, /TDD Gate/);
      assert.match(dispatch.content, /phase: pending/);
      assert.match(ctx.notifications[0].message, /tddPhase=pending/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("continue with TDD gate red dispatches find_and_fix and advances phase to green before dispatch", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const dispatched = [];
    const mockPi = {
      sendMessage(msg) {
        dispatched.push(msg);
      }
    };
    const saved = process.cwd();
    process.chdir(base);
    try {
      createDebugSession(base, { issue: "Cache miss", createdAt: 10 });
      updateDebugSession(base, "cache-miss", {
        tddGate: {
          enabled: true,
          phase: "red",
          testFile: "cache.test.ts",
          testName: "returns stale entry",
          failureOutput: "Expected 'fresh' to equal 'stale'"
        }
      });
      await handleDebug("continue cache-miss", ctx, mockPi);
      assert.equal(dispatched.length, 1);
      assert.match(dispatched[0].content, /`find_and_fix`/);
      assert.match(dispatched[0].content, /TDD Gate/);
      assert.match(dispatched[0].content, /red → green/);
      const statusCtx = createMockCtx();
      await handleDebug("status cache-miss", statusCtx);
      const { loadDebugSession: load } = await import("../debug-session-store.js");
      const record = load(base, "cache-miss");
      assert.ok(record != null);
      assert.equal(record.session.tddGate?.phase, "green");
      assert.match(ctx.notifications[0].message, /tddPhase=red→green/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("continue without checkpoint or TDD gate uses debug-diagnose template with find_and_fix (regression guard)", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const dispatched = [];
    const mockPi = {
      sendMessage(msg) {
        dispatched.push(msg);
      }
    };
    const saved = process.cwd();
    process.chdir(base);
    try {
      createDebugSession(base, { issue: "Login broken", createdAt: 10, status: "paused", phase: "blocked" });
      await handleDebug("continue login-broken", ctx, mockPi);
      assert.equal(dispatched.length, 1);
      const dispatch = dispatched[0];
      assert.equal(dispatch.customType, "gsd-debug-continue");
      assert.match(dispatch.content, /`find_and_fix`/);
      assert.doesNotMatch(dispatch.content, /## Active Checkpoint/);
      assert.doesNotMatch(dispatch.content, /## TDD Gate/);
      assert.match(ctx.notifications[0].message, /dispatchMode=find_and_fix/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
});
describe("debug-session-manager prompt template", () => {
  test("loadPrompt('debug-session-manager') returns content with all structured return header keywords", () => {
    const content = loadPrompt("debug-session-manager", {
      slug: "auth-flake",
      mode: "debug",
      issue: "Login fails on Safari",
      workingDirectory: "/repo",
      goal: "find_root_cause_only",
      checkpointContext: "",
      tddContext: "",
      specialistContext: ""
    });
    assert.match(content, /## ROOT CAUSE FOUND/);
    assert.match(content, /## TDD CHECKPOINT/);
    assert.match(content, /## CHECKPOINT REACHED/);
    assert.match(content, /## DEBUG COMPLETE/);
    assert.match(content, /## INVESTIGATION INCONCLUSIVE/);
  });
  test("template contains specialist mapping table keywords", () => {
    const content = loadPrompt("debug-session-manager", {
      slug: "auth-flake",
      mode: "debug",
      issue: "Login fails on Safari",
      workingDirectory: "/repo",
      goal: "find_root_cause_only",
      checkpointContext: "",
      tddContext: "",
      specialistContext: ""
    });
    assert.match(content, /typescript-expert/);
    assert.match(content, /supabase-postgres-best-practices/);
    assert.match(content, /LOOKS_GOOD/);
    assert.match(content, /SUGGEST_CHANGE/);
  });
});
describe("continue handler \u2014 specialist review dispatch", () => {
  test("continue with specialistReview present \u2014 dispatch payload contains specialist hint and verdict", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const dispatched = [];
    const mockPi = {
      sendMessage(msg) {
        dispatched.push(msg);
      }
    };
    const saved = process.cwd();
    process.chdir(base);
    try {
      createDebugSession(base, { issue: "Null pointer on login", createdAt: 10 });
      updateDebugSession(base, "null-pointer-on-login", {
        checkpoint: { type: "human-action", summary: "Check DB schema", awaitingResponse: true },
        specialistReview: {
          hint: "typescript",
          skill: "typescript-expert",
          verdict: "SUGGEST_CHANGE",
          detail: "Use optional chaining instead of null checks",
          reviewedAt: 1e3
        }
      });
      await handleDebug("continue null-pointer-on-login", ctx, mockPi);
      assert.equal(dispatched.length, 1);
      const content = dispatched[0].content;
      assert.match(content, /Prior Specialist Review/);
      assert.match(content, /hint: typescript/);
      assert.match(content, /verdict: SUGGEST_CHANGE/);
      assert.match(content, /Use optional chaining/);
      assert.match(ctx.notifications[0].message, /specialistHint=typescript/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("continue with specialistReview absent \u2014 specialistContext is empty and notification has no specialistHint", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const dispatched = [];
    const mockPi = {
      sendMessage(msg) {
        dispatched.push(msg);
      }
    };
    const saved = process.cwd();
    process.chdir(base);
    try {
      createDebugSession(base, { issue: "Slow query", createdAt: 10 });
      updateDebugSession(base, "slow-query", {
        checkpoint: { type: "human-action", summary: "Verify index exists", awaitingResponse: true }
      });
      await handleDebug("continue slow-query", ctx, mockPi);
      assert.equal(dispatched.length, 1);
      const content = dispatched[0].content;
      assert.doesNotMatch(content, /Prior Specialist Review/);
      assert.doesNotMatch(ctx.notifications[0].message, /specialistHint/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("continue with checkpoint + specialistReview \u2014 both contexts appear in dispatch", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const dispatched = [];
    const mockPi = {
      sendMessage(msg) {
        dispatched.push(msg);
      }
    };
    const saved = process.cwd();
    process.chdir(base);
    try {
      createDebugSession(base, { issue: "Memory leak in cache", createdAt: 10 });
      updateDebugSession(base, "memory-leak-in-cache", {
        checkpoint: {
          type: "human-verify",
          summary: "Verify heap snapshot shows leak",
          awaitingResponse: true,
          userResponse: "Yes, confirmed leak at line 42"
        },
        specialistReview: {
          hint: "database",
          skill: "supabase-postgres-best-practices",
          verdict: "LOOKS_GOOD",
          detail: "Query plan is optimal",
          reviewedAt: 2e3
        }
      });
      await handleDebug("continue memory-leak-in-cache", ctx, mockPi);
      assert.equal(dispatched.length, 1);
      const content = dispatched[0].content;
      assert.match(content, /Active Checkpoint/);
      assert.match(content, /Verify heap snapshot/);
      assert.match(content, /Prior Specialist Review/);
      assert.match(content, /hint: database/);
      assert.match(content, /verdict: LOOKS_GOOD/);
      assert.match(ctx.notifications[0].message, /checkpointType=human-verify/);
      assert.match(ctx.notifications[0].message, /specialistHint=database/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kZWJ1Zy1jb21tYW5kLWhhbmRsZXIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QsIHsgZGVzY3JpYmUgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHsgaGFuZGxlRGVidWcsIHBhcnNlRGVidWdDb21tYW5kIH0gZnJvbSBcIi4uL2NvbW1hbmRzLWRlYnVnLnRzXCI7XG5pbXBvcnQgeyBjcmVhdGVEZWJ1Z1Nlc3Npb24sIGRlYnVnU2Vzc2lvbkFydGlmYWN0UGF0aCwgdXBkYXRlRGVidWdTZXNzaW9uIH0gZnJvbSBcIi4uL2RlYnVnLXNlc3Npb24tc3RvcmUudHNcIjtcbmltcG9ydCB7IGxvYWRQcm9tcHQgfSBmcm9tIFwiLi4vcHJvbXB0LWxvYWRlci50c1wiO1xuXG5mdW5jdGlvbiBtYWtlQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtZGVidWctY29tbWFuZC1cIikpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlTW9ja0N0eCgpIHtcbiAgY29uc3Qgbm90aWZpY2F0aW9uczogQXJyYXk8eyBtZXNzYWdlOiBzdHJpbmc7IGxldmVsOiBzdHJpbmcgfT4gPSBbXTtcbiAgcmV0dXJuIHtcbiAgICBub3RpZmljYXRpb25zLFxuICAgIHVpOiB7XG4gICAgICBub3RpZnkobWVzc2FnZTogc3RyaW5nLCBsZXZlbDogc3RyaW5nKSB7XG4gICAgICAgIG5vdGlmaWNhdGlvbnMucHVzaCh7IG1lc3NhZ2UsIGxldmVsIH0pO1xuICAgICAgfSxcbiAgICB9LFxuICB9O1xufVxuXG5kZXNjcmliZShcInBhcnNlRGVidWdDb21tYW5kXCIsICgpID0+IHtcbiAgdGVzdChcInN1cHBvcnRzIHN0cmljdCBzdWJjb21tYW5kcyBhbmQgaXNzdWUtc3RhcnQgZmFsbGJhY2tcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5kZWVwRXF1YWwocGFyc2VEZWJ1Z0NvbW1hbmQoXCJsaXN0XCIpLCB7IHR5cGU6IFwibGlzdFwiIH0pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocGFyc2VEZWJ1Z0NvbW1hbmQoXCJzdGF0dXMgYXV0aC1mbGFrZVwiKSwgeyB0eXBlOiBcInN0YXR1c1wiLCBzbHVnOiBcImF1dGgtZmxha2VcIiB9KTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHBhcnNlRGVidWdDb21tYW5kKFwiY29udGludWUgYXV0aC1mbGFrZVwiKSwgeyB0eXBlOiBcImNvbnRpbnVlXCIsIHNsdWc6IFwiYXV0aC1mbGFrZVwiIH0pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocGFyc2VEZWJ1Z0NvbW1hbmQoXCItLWRpYWdub3NlXCIpLCB7IHR5cGU6IFwiZGlhZ25vc2VcIiB9KTtcbiAgfSk7XG5cbiAgdGVzdChcInRyZWF0cyBhbWJpZ3VvdXMgcmVzZXJ2ZWQtd29yZCBwaHJhc2VzIGFzIGlzc3VlIHRleHQgdW5sZXNzIHN0cmljdCBzeW50YXggbWF0Y2hlc1wiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChwYXJzZURlYnVnQ29tbWFuZChcInN0YXR1cyBsb2dpbiBmYWlscyBvbiBzYWZhcmlcIiksIHtcbiAgICAgIHR5cGU6IFwiaXNzdWUtc3RhcnRcIixcbiAgICAgIGlzc3VlOiBcInN0YXR1cyBsb2dpbiBmYWlscyBvbiBzYWZhcmlcIixcbiAgICB9KTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHBhcnNlRGVidWdDb21tYW5kKFwiY29udGludWUgZmxha3kgY2hlY2tvdXQgZmxvd1wiKSwge1xuICAgICAgdHlwZTogXCJpc3N1ZS1zdGFydFwiLFxuICAgICAgaXNzdWU6IFwiY29udGludWUgZmxha3kgY2hlY2tvdXQgZmxvd1wiLFxuICAgIH0pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocGFyc2VEZWJ1Z0NvbW1hbmQoXCJsaXN0IGJyb2tlbiByZXRyeSBiZWhhdmlvclwiKSwge1xuICAgICAgdHlwZTogXCJpc3N1ZS1zdGFydFwiLFxuICAgICAgaXNzdWU6IFwibGlzdCBicm9rZW4gcmV0cnkgYmVoYXZpb3JcIixcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgYWN0aW9uYWJsZSBlcnJvcnMgZm9yIG1hbGZvcm1lZCBzdWJjb21tYW5kIGludm9jYXRpb25zXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwocGFyc2VEZWJ1Z0NvbW1hbmQoXCJzdGF0dXNcIikudHlwZSwgXCJlcnJvclwiKTtcbiAgICBhc3NlcnQuZXF1YWwocGFyc2VEZWJ1Z0NvbW1hbmQoXCJjb250aW51ZVwiKS50eXBlLCBcImVycm9yXCIpO1xuICAgIGFzc2VydC5lcXVhbChwYXJzZURlYnVnQ29tbWFuZChcIi0tZGlhZ25vc2Ugbm90L2Etc2x1Z1wiKS50eXBlLCBcImVycm9yXCIpO1xuICAgIGFzc2VydC5lcXVhbChwYXJzZURlYnVnQ29tbWFuZChcIi0td2F0XCIpLnR5cGUsIFwiZXJyb3JcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJyb3V0ZXMgbXVsdGktdG9rZW4gLS1kaWFnbm9zZSB0byBkaWFnbm9zZS1pc3N1ZSB3aXRoIHJvb3QtY2F1c2Utb25seSBpbnRlbnRcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5kZWVwRXF1YWwocGFyc2VEZWJ1Z0NvbW1hbmQoXCItLWRpYWdub3NlIGxvZ2luIGZhaWxzIG9uIHNhZmFyaVwiKSwge1xuICAgICAgdHlwZTogXCJkaWFnbm9zZS1pc3N1ZVwiLFxuICAgICAgaXNzdWU6IFwibG9naW4gZmFpbHMgb24gc2FmYXJpXCIsXG4gICAgfSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChwYXJzZURlYnVnQ29tbWFuZChcIi0tZGlhZ25vc2UgZmxha3kgY2hlY2tvdXQgZmxvd1wiKSwge1xuICAgICAgdHlwZTogXCJkaWFnbm9zZS1pc3N1ZVwiLFxuICAgICAgaXNzdWU6IFwiZmxha3kgY2hlY2tvdXQgZmxvd1wiLFxuICAgIH0pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocGFyc2VEZWJ1Z0NvbW1hbmQoXCItLWRpYWdub3NlIHN0YXR1cyBpcyByZXR1cm5pbmcgNTAwXCIpLCB7XG4gICAgICB0eXBlOiBcImRpYWdub3NlLWlzc3VlXCIsXG4gICAgICBpc3N1ZTogXCJzdGF0dXMgaXMgcmV0dXJuaW5nIDUwMFwiLFxuICAgIH0pO1xuICB9KTtcblxuICB0ZXN0KFwiLS1kaWFnbm9zZSB3aXRoIHZhbGlkIHNsdWcgcmVtYWlucyBzbHVnLXRhcmdldGVkIGRpYWdub3NlXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHBhcnNlRGVidWdDb21tYW5kKFwiLS1kaWFnbm9zZSBhdXRoLWZsYWtlXCIpLCB7XG4gICAgICB0eXBlOiBcImRpYWdub3NlXCIsXG4gICAgICBzbHVnOiBcImF1dGgtZmxha2VcIixcbiAgICB9KTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHBhcnNlRGVidWdDb21tYW5kKFwiLS1kaWFnbm9zZSBjaS1mbGFrZS0yXCIpLCB7XG4gICAgICB0eXBlOiBcImRpYWdub3NlXCIsXG4gICAgICBzbHVnOiBcImNpLWZsYWtlLTJcIixcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdChcIi0tZGlhZ25vc2Ugd2l0aCBubyBhcmdzIHJldHVybnMgc3RvcmUtaGVhbHRoIGRpYWdub3NlXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHBhcnNlRGVidWdDb21tYW5kKFwiLS1kaWFnbm9zZVwiKSwgeyB0eXBlOiBcImRpYWdub3NlXCIgfSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJzaW5nbGUgaW52YWxpZCBzbHVnIHRva2VuIGFmdGVyIC0tZGlhZ25vc2UgaXMgYW4gZXJyb3Igbm90IGlzc3VlLXN0YXJ0XCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwocGFyc2VEZWJ1Z0NvbW1hbmQoXCItLWRpYWdub3NlIG5vdC9hLXNsdWdcIikudHlwZSwgXCJlcnJvclwiKTtcbiAgICBhc3NlcnQuZXF1YWwocGFyc2VEZWJ1Z0NvbW1hbmQoXCItLWRpYWdub3NlIFVQUEVSQ0FTRVwiKS50eXBlLCBcImVycm9yXCIpO1xuICAgIGFzc2VydC5lcXVhbChwYXJzZURlYnVnQ29tbWFuZChcIi0tZGlhZ25vc2UgaGFzIHNwYWNlXCIpLnR5cGUsIFwiZGlhZ25vc2UtaXNzdWVcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJpc3N1ZSB0ZXh0IHN0YXJ0aW5nIHdpdGggcmVzZXJ2ZWQgd29yZHMgZmFsbHMgdGhyb3VnaCB0byBpc3N1ZS1zdGFydFwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChwYXJzZURlYnVnQ29tbWFuZChcImxpc3QgYnJva2VuIHJldHJ5IGJlaGF2aW9yXCIpLCB7XG4gICAgICB0eXBlOiBcImlzc3VlLXN0YXJ0XCIsXG4gICAgICBpc3N1ZTogXCJsaXN0IGJyb2tlbiByZXRyeSBiZWhhdmlvclwiLFxuICAgIH0pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocGFyc2VEZWJ1Z0NvbW1hbmQoXCJzdGF0dXMgbG9naW4gaXMgZmxha3lcIiksIHtcbiAgICAgIHR5cGU6IFwiaXNzdWUtc3RhcnRcIixcbiAgICAgIGlzc3VlOiBcInN0YXR1cyBsb2dpbiBpcyBmbGFreVwiLFxuICAgIH0pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocGFyc2VEZWJ1Z0NvbW1hbmQoXCJjb250aW51ZSBmbGFreSBjaGVja291dCBmbG93XCIpLCB7XG4gICAgICB0eXBlOiBcImlzc3VlLXN0YXJ0XCIsXG4gICAgICBpc3N1ZTogXCJjb250aW51ZSBmbGFreSBjaGVja291dCBmbG93XCIsXG4gICAgfSk7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiaGFuZGxlRGVidWcgbGlmZWN5Y2xlXCIsICgpID0+IHtcbiAgdGVzdChcImNyZWF0ZXMgbmV3IHNlc3Npb24gYW5kIHBlcnNpc3RzIG1vZGUvcGhhc2UgbWV0YWRhdGFcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIGNvbnN0IGN0eCA9IGNyZWF0ZU1vY2tDdHgoKTtcbiAgICBjb25zdCBzYXZlZCA9IHByb2Nlc3MuY3dkKCk7XG4gICAgcHJvY2Vzcy5jaGRpcihiYXNlKTtcblxuICAgIHRyeSB7XG4gICAgICBhd2FpdCBoYW5kbGVEZWJ1ZyhcIkxvZ2luIGZhaWxzIG9uIFNhZmFyaVwiLCBjdHggYXMgYW55KTtcbiAgICAgIGFzc2VydC5lcXVhbChjdHgubm90aWZpY2F0aW9ucy5sZW5ndGgsIDEpO1xuICAgICAgY29uc3Qgbm90ZSA9IGN0eC5ub3RpZmljYXRpb25zWzBdO1xuICAgICAgYXNzZXJ0LmVxdWFsKG5vdGUubGV2ZWwsIFwiaW5mb1wiKTtcbiAgICAgIGFzc2VydC5tYXRjaChub3RlLm1lc3NhZ2UsIC9EZWJ1ZyBzZXNzaW9uIHN0YXJ0ZWQ6IGxvZ2luLWZhaWxzLW9uLXNhZmFyaS8pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKG5vdGUubWVzc2FnZSwgL21vZGU9ZGVidWcvKTtcbiAgICAgIGFzc2VydC5tYXRjaChub3RlLm1lc3NhZ2UsIC9waGFzZT1xdWV1ZWQvKTtcblxuICAgICAgY29uc3QgYXJ0aWZhY3QgPSBkZWJ1Z1Nlc3Npb25BcnRpZmFjdFBhdGgoYmFzZSwgXCJsb2dpbi1mYWlscy1vbi1zYWZhcmlcIik7XG4gICAgICBjb25zdCBzdGF0dXNDdHggPSBjcmVhdGVNb2NrQ3R4KCk7XG4gICAgICBhd2FpdCBoYW5kbGVEZWJ1ZyhcInN0YXR1cyBsb2dpbi1mYWlscy1vbi1zYWZhcmlcIiwgc3RhdHVzQ3R4IGFzIGFueSk7XG4gICAgICBhc3NlcnQubWF0Y2goc3RhdHVzQ3R4Lm5vdGlmaWNhdGlvbnNbMF0ubWVzc2FnZSwgbmV3IFJlZ0V4cChhcnRpZmFjdC5yZXBsYWNlKC9bLiorP14ke30oKXxbXFxdXFxcXF0vZywgXCJcXFxcJCZcIikpKTtcbiAgICAgIGFzc2VydC5tYXRjaChzdGF0dXNDdHgubm90aWZpY2F0aW9uc1swXS5tZXNzYWdlLCAvc3RhdHVzPWFjdGl2ZS8pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKHN0YXR1c0N0eC5ub3RpZmljYXRpb25zWzBdLm1lc3NhZ2UsIC9waGFzZT1xdWV1ZWQvKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcHJvY2Vzcy5jaGRpcihzYXZlZCk7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImlzc3VlLXN0YXJ0IGRpc3BhdGNoZXMgYSBmaW5kX2FuZF9maXggZGVidWcgcnVubmVyIGFmdGVyIGNyZWF0aW5nIHRoZSBzZXNzaW9uXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgICBjb25zdCBjdHggPSBjcmVhdGVNb2NrQ3R4KCk7XG4gICAgY29uc3QgZGlzcGF0Y2hlZDogQXJyYXk8e1xuICAgICAgbXNnOiB7IGN1c3RvbVR5cGU6IHN0cmluZzsgY29udGVudDogc3RyaW5nOyBkaXNwbGF5OiBib29sZWFuIH07XG4gICAgICBvcHRpb25zOiB7IHRyaWdnZXJUdXJuOiBib29sZWFuIH07XG4gICAgfT4gPSBbXTtcbiAgICBjb25zdCBtb2NrUGkgPSB7XG4gICAgICBzZW5kTWVzc2FnZShcbiAgICAgICAgbXNnOiB7IGN1c3RvbVR5cGU6IHN0cmluZzsgY29udGVudDogc3RyaW5nOyBkaXNwbGF5OiBib29sZWFuIH0sXG4gICAgICAgIG9wdGlvbnM6IHsgdHJpZ2dlclR1cm46IGJvb2xlYW4gfSxcbiAgICAgICkge1xuICAgICAgICBkaXNwYXRjaGVkLnB1c2goeyBtc2csIG9wdGlvbnMgfSk7XG4gICAgICB9LFxuICAgIH07XG4gICAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmN3ZCgpO1xuICAgIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgICB0cnkge1xuICAgICAgYXdhaXQgaGFuZGxlRGVidWcoXCJMb2dpbiBmYWlscyBvbiBTYWZhcmlcIiwgY3R4IGFzIGFueSwgbW9ja1BpIGFzIGFueSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChjdHgubm90aWZpY2F0aW9uc1swXS5sZXZlbCwgXCJpbmZvXCIpO1xuICAgICAgYXNzZXJ0Lm1hdGNoKGN0eC5ub3RpZmljYXRpb25zWzBdLm1lc3NhZ2UsIC9EZWJ1ZyBzZXNzaW9uIHN0YXJ0ZWQ6IGxvZ2luLWZhaWxzLW9uLXNhZmFyaS8pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKGN0eC5ub3RpZmljYXRpb25zWzBdLm1lc3NhZ2UsIC9kaXNwYXRjaE1vZGU9ZmluZF9hbmRfZml4Lyk7XG4gICAgICBhc3NlcnQuZXF1YWwoZGlzcGF0Y2hlZC5sZW5ndGgsIDEpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGRpc3BhdGNoZWRbMF0ubXNnLmN1c3RvbVR5cGUsIFwiZ3NkLWRlYnVnLXN0YXJ0XCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGRpc3BhdGNoZWRbMF0ubXNnLmRpc3BsYXksIGZhbHNlKTtcbiAgICAgIGFzc2VydC5lcXVhbChkaXNwYXRjaGVkWzBdLm9wdGlvbnMudHJpZ2dlclR1cm4sIHRydWUpO1xuICAgICAgYXNzZXJ0Lm1hdGNoKGRpc3BhdGNoZWRbMF0ubXNnLmNvbnRlbnQsIC9gZmluZF9hbmRfZml4YC8pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKGRpc3BhdGNoZWRbMF0ubXNnLmNvbnRlbnQsIC9sb2dpbi1mYWlscy1vbi1zYWZhcmkvKTtcbiAgICAgIGFzc2VydC5tYXRjaChkaXNwYXRjaGVkWzBdLm1zZy5jb250ZW50LCAvTG9naW4gZmFpbHMgb24gU2FmYXJpLyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHByb2Nlc3MuY2hkaXIoc2F2ZWQpO1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJsaXN0IHNob3dzIHBlcnNpc3RlZCBzZXNzaW9uIHN1bW1hcmllcyB3aXRoIGxpZmVjeWNsZSBtZXRhZGF0YVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgY29uc3QgY3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuICAgIGNvbnN0IHNhdmVkID0gcHJvY2Vzcy5jd2QoKTtcbiAgICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNyZWF0ZURlYnVnU2Vzc2lvbihiYXNlLCB7IGlzc3VlOiBcIkF1dGggdGltZW91dFwiLCBjcmVhdGVkQXQ6IDEwIH0pO1xuICAgICAgY3JlYXRlRGVidWdTZXNzaW9uKGJhc2UsIHsgaXNzdWU6IFwiQmlsbGluZyB3ZWJob29rXCIsIGNyZWF0ZWRBdDogMjAgfSk7XG5cbiAgICAgIGF3YWl0IGhhbmRsZURlYnVnKFwibGlzdFwiLCBjdHggYXMgYW55KTtcbiAgICAgIGFzc2VydC5lcXVhbChjdHgubm90aWZpY2F0aW9ucy5sZW5ndGgsIDEpO1xuICAgICAgY29uc3Qgbm90ZSA9IGN0eC5ub3RpZmljYXRpb25zWzBdLm1lc3NhZ2U7XG4gICAgICBhc3NlcnQubWF0Y2gobm90ZSwgL0RlYnVnIHNlc3Npb25zOi8pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKG5vdGUsIC9tb2RlPWRlYnVnIHN0YXR1cz1hY3RpdmUgcGhhc2U9cXVldWVkLyk7XG4gICAgICBhc3NlcnQubWF0Y2gobm90ZSwgL2F1dGgtdGltZW91dC8pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKG5vdGUsIC9iaWxsaW5nLXdlYmhvb2svKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcHJvY2Vzcy5jaGRpcihzYXZlZCk7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImNvbnRpbnVlIHVwZGF0ZXMgc2Vzc2lvbiBsaWZlY3ljbGUgc3RhdGVcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIGNvbnN0IGN0eCA9IGNyZWF0ZU1vY2tDdHgoKTtcbiAgICBjb25zdCBzYXZlZCA9IHByb2Nlc3MuY3dkKCk7XG4gICAgcHJvY2Vzcy5jaGRpcihiYXNlKTtcblxuICAgIHRyeSB7XG4gICAgICBjcmVhdGVEZWJ1Z1Nlc3Npb24oYmFzZSwgeyBpc3N1ZTogXCJDSSBmbGFrZVwiLCBjcmVhdGVkQXQ6IDEwLCBzdGF0dXM6IFwicGF1c2VkXCIsIHBoYXNlOiBcImJsb2NrZWRcIiB9KTtcblxuICAgICAgYXdhaXQgaGFuZGxlRGVidWcoXCJjb250aW51ZSBjaS1mbGFrZVwiLCBjdHggYXMgYW55KTtcbiAgICAgIGFzc2VydC5lcXVhbChjdHgubm90aWZpY2F0aW9ucy5sZW5ndGgsIDEpO1xuICAgICAgY29uc3Qgbm90ZSA9IGN0eC5ub3RpZmljYXRpb25zWzBdLm1lc3NhZ2U7XG4gICAgICBhc3NlcnQubWF0Y2gobm90ZSwgL1Jlc3VtZWQgZGVidWcgc2Vzc2lvbjogY2ktZmxha2UvKTtcbiAgICAgIGFzc2VydC5tYXRjaChub3RlLCAvc3RhdHVzPWFjdGl2ZS8pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKG5vdGUsIC9waGFzZT1jb250aW51ZWQvKTtcblxuICAgICAgY29uc3Qgc3RhdHVzQ3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuICAgICAgYXdhaXQgaGFuZGxlRGVidWcoXCJzdGF0dXMgY2ktZmxha2VcIiwgc3RhdHVzQ3R4IGFzIGFueSk7XG4gICAgICBhc3NlcnQubWF0Y2goc3RhdHVzQ3R4Lm5vdGlmaWNhdGlvbnNbMF0ubWVzc2FnZSwgL3N0YXR1cz1hY3RpdmUvKTtcbiAgICAgIGFzc2VydC5tYXRjaChzdGF0dXNDdHgubm90aWZpY2F0aW9uc1swXS5tZXNzYWdlLCAvcGhhc2U9Y29udGludWVkLyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHByb2Nlc3MuY2hkaXIoc2F2ZWQpO1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJ1bmtub3duIHNsdWcgYW5kIG1pc3Npbmcgc2x1ZyBwYXRocyBwcm92aWRlIGFjdGlvbmFibGUgd2FybmluZ3NcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIGNvbnN0IHNhdmVkID0gcHJvY2Vzcy5jd2QoKTtcbiAgICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IG1pc3NpbmdTbHVnQ3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuICAgICAgYXdhaXQgaGFuZGxlRGVidWcoXCJzdGF0dXNcIiwgbWlzc2luZ1NsdWdDdHggYXMgYW55KTtcbiAgICAgIGFzc2VydC5lcXVhbChtaXNzaW5nU2x1Z0N0eC5ub3RpZmljYXRpb25zWzBdLmxldmVsLCBcIndhcm5pbmdcIik7XG4gICAgICBhc3NlcnQubWF0Y2gobWlzc2luZ1NsdWdDdHgubm90aWZpY2F0aW9uc1swXS5tZXNzYWdlLCAvTWlzc2luZyBzbHVnLyk7XG5cbiAgICAgIGNvbnN0IHVua25vd25TbHVnQ3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuICAgICAgYXdhaXQgaGFuZGxlRGVidWcoXCJzdGF0dXMgbm8tc3VjaC1zZXNzaW9uXCIsIHVua25vd25TbHVnQ3R4IGFzIGFueSk7XG4gICAgICBhc3NlcnQuZXF1YWwodW5rbm93blNsdWdDdHgubm90aWZpY2F0aW9uc1swXS5sZXZlbCwgXCJ3YXJuaW5nXCIpO1xuICAgICAgYXNzZXJ0Lm1hdGNoKHVua25vd25TbHVnQ3R4Lm5vdGlmaWNhdGlvbnNbMF0ubWVzc2FnZSwgL1Vua25vd24gZGVidWcgc2Vzc2lvbiBzbHVnLyk7XG4gICAgICBhc3NlcnQubWF0Y2godW5rbm93blNsdWdDdHgubm90aWZpY2F0aW9uc1swXS5tZXNzYWdlLCAvXFwvZ3NkIGRlYnVnIGxpc3QvKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcHJvY2Vzcy5jaGRpcihzYXZlZCk7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImRldGVjdHMgbWFsZm9ybWVkIGFydGlmYWN0cyBhbmQgc3VyZmFjZXMgcmVtZWRpYXRpb24gaW4gbGlzdC9kaWFnbm9zZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmN3ZCgpO1xuICAgIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgICB0cnkge1xuICAgICAgY3JlYXRlRGVidWdTZXNzaW9uKGJhc2UsIHsgaXNzdWU6IFwiSGVhbHRoeSBpc3N1ZVwiLCBjcmVhdGVkQXQ6IDEgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZGVidWdcIiwgXCJzZXNzaW9uc1wiLCBcImJyb2tlbi5qc29uXCIpLCBcInsgbm9wZVwiLCBcInV0Zi04XCIpO1xuXG4gICAgICBjb25zdCBsaXN0Q3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuICAgICAgYXdhaXQgaGFuZGxlRGVidWcoXCJsaXN0XCIsIGxpc3RDdHggYXMgYW55KTtcbiAgICAgIGFzc2VydC5tYXRjaChsaXN0Q3R4Lm5vdGlmaWNhdGlvbnNbMF0ubWVzc2FnZSwgL01hbGZvcm1lZCBhcnRpZmFjdHM6IDEvKTtcbiAgICAgIGFzc2VydC5tYXRjaChsaXN0Q3R4Lm5vdGlmaWNhdGlvbnNbMF0ubWVzc2FnZSwgL1J1biBcXC9nc2QgZGVidWcgLS1kaWFnbm9zZS8pO1xuXG4gICAgICBjb25zdCBkaWFnbm9zZUN0eCA9IGNyZWF0ZU1vY2tDdHgoKTtcbiAgICAgIGF3YWl0IGhhbmRsZURlYnVnKFwiLS1kaWFnbm9zZVwiLCBkaWFnbm9zZUN0eCBhcyBhbnkpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGRpYWdub3NlQ3R4Lm5vdGlmaWNhdGlvbnNbMF0ubGV2ZWwsIFwid2FybmluZ1wiKTtcbiAgICAgIGFzc2VydC5tYXRjaChkaWFnbm9zZUN0eC5ub3RpZmljYXRpb25zWzBdLm1lc3NhZ2UsIC9NYWxmb3JtZWQgYXJ0aWZhY3RzLyk7XG4gICAgICBhc3NlcnQubWF0Y2goZGlhZ25vc2VDdHgubm90aWZpY2F0aW9uc1swXS5tZXNzYWdlLCAvUmVtZWRpYXRpb246Lyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHByb2Nlc3MuY2hkaXIoc2F2ZWQpO1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXNlcnZlZC13b3JkIGJvdW5kYXJ5IGNvbmRpdGlvbiBzdGlsbCBjcmVhdGVzIHNlc3Npb24gd2hlbiBzeW50YXggaXMgbm90IHN0cmljdFwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmN3ZCgpO1xuICAgIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgY3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuICAgICAgYXdhaXQgaGFuZGxlRGVidWcoXCJzdGF0dXMgbG9naW4gaXMgZmxha3kgb24gcHJvZFwiLCBjdHggYXMgYW55KTtcbiAgICAgIGFzc2VydC5lcXVhbChjdHgubm90aWZpY2F0aW9uc1swXS5sZXZlbCwgXCJpbmZvXCIpO1xuICAgICAgYXNzZXJ0Lm1hdGNoKGN0eC5ub3RpZmljYXRpb25zWzBdLm1lc3NhZ2UsIC9EZWJ1ZyBzZXNzaW9uIHN0YXJ0ZWQ6Lyk7XG5cbiAgICAgIGNvbnN0IHNsdWcgPSBcInN0YXR1cy1sb2dpbi1pcy1mbGFreS1vbi1wcm9kXCI7XG4gICAgICBjb25zdCBzdGF0dXNDdHggPSBjcmVhdGVNb2NrQ3R4KCk7XG4gICAgICBhd2FpdCBoYW5kbGVEZWJ1Zyhgc3RhdHVzICR7c2x1Z31gLCBzdGF0dXNDdHggYXMgYW55KTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0dXNDdHgubm90aWZpY2F0aW9uc1swXS5sZXZlbCwgXCJpbmZvXCIpO1xuICAgICAgYXNzZXJ0Lm1hdGNoKHN0YXR1c0N0eC5ub3RpZmljYXRpb25zWzBdLm1lc3NhZ2UsIC9tb2RlPWRlYnVnLyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHByb2Nlc3MuY2hkaXIoc2F2ZWQpO1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCItLWRpYWdub3NlIDxpc3N1ZSB0ZXh0PiBjcmVhdGVzIGRpYWdub3NlIHNlc3Npb24gd2l0aCBtb2RlPWRpYWdub3NlIGFuZCBmaW5kX3Jvb3RfY2F1c2Vfb25seSBkaXNwYXRjaFwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgY29uc3QgY3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuICAgIGNvbnN0IHNhdmVkID0gcHJvY2Vzcy5jd2QoKTtcbiAgICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGhhbmRsZURlYnVnKFwiLS1kaWFnbm9zZSBsb2dpbiBmYWlscyBvbiBzYWZhcmlcIiwgY3R4IGFzIGFueSk7XG4gICAgICBhc3NlcnQuZXF1YWwoY3R4Lm5vdGlmaWNhdGlvbnMubGVuZ3RoLCAxKTtcbiAgICAgIGNvbnN0IG5vdGUgPSBjdHgubm90aWZpY2F0aW9uc1swXTtcbiAgICAgIGFzc2VydC5lcXVhbChub3RlLmxldmVsLCBcImluZm9cIik7XG4gICAgICBhc3NlcnQubWF0Y2gobm90ZS5tZXNzYWdlLCAvRGlhZ25vc2Ugc2Vzc2lvbiBzdGFydGVkOiBsb2dpbi1mYWlscy1vbi1zYWZhcmkvKTtcbiAgICAgIGFzc2VydC5tYXRjaChub3RlLm1lc3NhZ2UsIC9tb2RlPWRpYWdub3NlLyk7XG4gICAgICBhc3NlcnQubWF0Y2gobm90ZS5tZXNzYWdlLCAvZGlzcGF0Y2hNb2RlPWZpbmRfcm9vdF9jYXVzZV9vbmx5Lyk7XG4gICAgICBhc3NlcnQubWF0Y2gobm90ZS5tZXNzYWdlLCAvcGhhc2U9cXVldWVkLyk7XG4gICAgICBhc3NlcnQubWF0Y2gobm90ZS5tZXNzYWdlLCAvc3RhdHVzPWFjdGl2ZS8pO1xuXG4gICAgICBjb25zdCBzdGF0dXNDdHggPSBjcmVhdGVNb2NrQ3R4KCk7XG4gICAgICBhd2FpdCBoYW5kbGVEZWJ1ZyhcInN0YXR1cyBsb2dpbi1mYWlscy1vbi1zYWZhcmlcIiwgc3RhdHVzQ3R4IGFzIGFueSk7XG4gICAgICBhc3NlcnQubWF0Y2goc3RhdHVzQ3R4Lm5vdGlmaWNhdGlvbnNbMF0ubWVzc2FnZSwgL21vZGU9ZGlhZ25vc2UvKTtcbiAgICAgIGFzc2VydC5tYXRjaChzdGF0dXNDdHgubm90aWZpY2F0aW9uc1swXS5tZXNzYWdlLCAvc3RhdHVzPWFjdGl2ZS8pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmNoZGlyKHNhdmVkKTtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiLS1kaWFnbm9zZSA8c2x1Zz4gdGFyZ2V0cyBleGlzdGluZyBzZXNzaW9uIGZvciB0YXJnZXRlZCBkaWFnbm9zZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmN3ZCgpO1xuICAgIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgICB0cnkge1xuICAgICAgY3JlYXRlRGVidWdTZXNzaW9uKGJhc2UsIHsgaXNzdWU6IFwiQ0kgZmxha2Ugb24gbWFpblwiLCBjcmVhdGVkQXQ6IDEgfSk7XG5cbiAgICAgIGNvbnN0IGN0eCA9IGNyZWF0ZU1vY2tDdHgoKTtcbiAgICAgIGF3YWl0IGhhbmRsZURlYnVnKFwiLS1kaWFnbm9zZSBjaS1mbGFrZS1vbi1tYWluXCIsIGN0eCBhcyBhbnkpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGN0eC5ub3RpZmljYXRpb25zLmxlbmd0aCwgMSk7XG4gICAgICBhc3NlcnQuZXF1YWwoY3R4Lm5vdGlmaWNhdGlvbnNbMF0ubGV2ZWwsIFwiaW5mb1wiKTtcbiAgICAgIGFzc2VydC5tYXRjaChjdHgubm90aWZpY2F0aW9uc1swXS5tZXNzYWdlLCAvRGlhZ25vc2Ugc2Vzc2lvbjogY2ktZmxha2Utb24tbWFpbi8pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKGN0eC5ub3RpZmljYXRpb25zWzBdLm1lc3NhZ2UsIC9zdGF0dXM9YWN0aXZlLyk7XG4gICAgICBhc3NlcnQubWF0Y2goY3R4Lm5vdGlmaWNhdGlvbnNbMF0ubWVzc2FnZSwgL21hbGZvcm1lZEFydGlmYWN0c0luU3RvcmU9MC8pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmNoZGlyKHNhdmVkKTtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiLS1kaWFnbm9zZSB3aXRoIHVua25vd24gc2x1ZyBlbWl0cyBhY3Rpb25hYmxlIHdhcm5pbmdcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIGNvbnN0IHNhdmVkID0gcHJvY2Vzcy5jd2QoKTtcbiAgICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGN0eCA9IGNyZWF0ZU1vY2tDdHgoKTtcbiAgICAgIGF3YWl0IGhhbmRsZURlYnVnKFwiLS1kaWFnbm9zZSBuby1zdWNoLXNlc3Npb25cIiwgY3R4IGFzIGFueSk7XG4gICAgICBhc3NlcnQuZXF1YWwoY3R4Lm5vdGlmaWNhdGlvbnNbMF0ubGV2ZWwsIFwid2FybmluZ1wiKTtcbiAgICAgIGFzc2VydC5tYXRjaChjdHgubm90aWZpY2F0aW9uc1swXS5tZXNzYWdlLCAvbm90IGZvdW5kLyk7XG4gICAgICBhc3NlcnQubWF0Y2goY3R4Lm5vdGlmaWNhdGlvbnNbMF0ubWVzc2FnZSwgL1xcL2dzZCBkZWJ1ZyBsaXN0Lyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHByb2Nlc3MuY2hkaXIoc2F2ZWQpO1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJkaWFnbm9zZS1pc3N1ZSB0b2xlcmF0ZXMgbWFsZm9ybWVkIGFydGlmYWN0IGluIHN0b3JlIGFuZCBzdGlsbCBjcmVhdGVzIHNlc3Npb25cIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIGNvbnN0IHNhdmVkID0gcHJvY2Vzcy5jd2QoKTtcbiAgICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNyZWF0ZURlYnVnU2Vzc2lvbihiYXNlLCB7IGlzc3VlOiBcIkhlYWx0aHkgaXNzdWVcIiwgY3JlYXRlZEF0OiAxIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcImRlYnVnXCIsIFwic2Vzc2lvbnNcIiwgXCJicm9rZW4uanNvblwiKSwgXCJ7IG5vcGVcIiwgXCJ1dGYtOFwiKTtcblxuICAgICAgY29uc3QgY3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuICAgICAgYXdhaXQgaGFuZGxlRGVidWcoXCItLWRpYWdub3NlIGJpbGxpbmcgd2ViaG9vayBpcyBkcm9wcGluZyBldmVudHNcIiwgY3R4IGFzIGFueSk7XG4gICAgICBhc3NlcnQuZXF1YWwoY3R4Lm5vdGlmaWNhdGlvbnNbMF0ubGV2ZWwsIFwiaW5mb1wiKTtcbiAgICAgIGFzc2VydC5tYXRjaChjdHgubm90aWZpY2F0aW9uc1swXS5tZXNzYWdlLCAvRGlhZ25vc2Ugc2Vzc2lvbiBzdGFydGVkOi8pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKGN0eC5ub3RpZmljYXRpb25zWzBdLm1lc3NhZ2UsIC9tb2RlPWRpYWdub3NlLyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHByb2Nlc3MuY2hkaXIoc2F2ZWQpO1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJjb250aW51ZSBibG9ja3Mgb24gcmVzb2x2ZWQgc2Vzc2lvbiB3aXRoIGFjdGlvbmFibGUgd2FybmluZ1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmN3ZCgpO1xuICAgIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgICB0cnkge1xuICAgICAgY3JlYXRlRGVidWdTZXNzaW9uKGJhc2UsIHsgaXNzdWU6IFwiRG9uZSBpc3N1ZVwiLCBjcmVhdGVkQXQ6IDEsIHN0YXR1czogXCJyZXNvbHZlZFwiLCBwaGFzZTogXCJjb21wbGV0ZVwiIH0pO1xuXG4gICAgICBjb25zdCBjdHggPSBjcmVhdGVNb2NrQ3R4KCk7XG4gICAgICBhd2FpdCBoYW5kbGVEZWJ1ZyhcImNvbnRpbnVlIGRvbmUtaXNzdWVcIiwgY3R4IGFzIGFueSk7XG4gICAgICBhc3NlcnQuZXF1YWwoY3R4Lm5vdGlmaWNhdGlvbnNbMF0ubGV2ZWwsIFwid2FybmluZ1wiKTtcbiAgICAgIGFzc2VydC5tYXRjaChjdHgubm90aWZpY2F0aW9uc1swXS5tZXNzYWdlLCAvcmVzb2x2ZWQvKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcHJvY2Vzcy5jaGRpcihzYXZlZCk7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInVua25vd24gZmxhZyByZXR1cm5zIGVycm9yIHdpdGhvdXQgc2lsZW50bHkgcm91dGluZyB0byB3cm9uZyBwYXRoXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgICBjb25zdCBzYXZlZCA9IHByb2Nlc3MuY3dkKCk7XG4gICAgcHJvY2Vzcy5jaGRpcihiYXNlKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBjdHggPSBjcmVhdGVNb2NrQ3R4KCk7XG4gICAgICBhd2FpdCBoYW5kbGVEZWJ1ZyhcIi0tdW5rbm93bi1mbGFnIHNvbWUgdGV4dFwiLCBjdHggYXMgYW55KTtcbiAgICAgIGFzc2VydC5lcXVhbChjdHgubm90aWZpY2F0aW9uc1swXS5sZXZlbCwgXCJ3YXJuaW5nXCIpO1xuICAgICAgYXNzZXJ0Lm1hdGNoKGN0eC5ub3RpZmljYXRpb25zWzBdLm1lc3NhZ2UsIC9Vbmtub3duIGRlYnVnIGZsYWcvKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcHJvY2Vzcy5jaGRpcihzYXZlZCk7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImRpYWdub3NlLWlzc3VlIGRpc3BhdGNoZXMgZmluZF9yb290X2NhdXNlX29ubHkgZ29hbCB3aXRoIHNsdWcgYW5kIGlzc3VlIGluIHBheWxvYWRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIGNvbnN0IGN0eCA9IGNyZWF0ZU1vY2tDdHgoKTtcbiAgICBjb25zdCBkaXNwYXRjaGVkOiBBcnJheTx7IGN1c3RvbVR5cGU6IHN0cmluZzsgY29udGVudDogc3RyaW5nOyBkaXNwbGF5OiBib29sZWFuIH0+ID0gW107XG4gICAgY29uc3QgbW9ja1BpID0ge1xuICAgICAgc2VuZE1lc3NhZ2UobXNnOiB7IGN1c3RvbVR5cGU6IHN0cmluZzsgY29udGVudDogc3RyaW5nOyBkaXNwbGF5OiBib29sZWFuIH0pIHtcbiAgICAgICAgZGlzcGF0Y2hlZC5wdXNoKG1zZyk7XG4gICAgICB9LFxuICAgIH07XG4gICAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmN3ZCgpO1xuICAgIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgICB0cnkge1xuICAgICAgYXdhaXQgaGFuZGxlRGVidWcoXCItLWRpYWdub3NlIG1lbW9yeSBsZWFrIGluIHdvcmtlciBwb29sXCIsIGN0eCBhcyBhbnksIG1vY2tQaSBhcyBhbnkpO1xuICAgICAgLy8gU2Vzc2lvbiBjcmVhdGlvbiBub3RpZmljYXRpb24gc3RpbGwgZmlyZXNcbiAgICAgIGFzc2VydC5lcXVhbChjdHgubm90aWZpY2F0aW9uc1swXS5sZXZlbCwgXCJpbmZvXCIpO1xuICAgICAgYXNzZXJ0Lm1hdGNoKGN0eC5ub3RpZmljYXRpb25zWzBdLm1lc3NhZ2UsIC9kaXNwYXRjaE1vZGU9ZmluZF9yb290X2NhdXNlX29ubHkvKTtcblxuICAgICAgLy8gRXhhY3RseSBvbmUgZGlzcGF0Y2ggd2FzIGVtaXR0ZWRcbiAgICAgIGFzc2VydC5lcXVhbChkaXNwYXRjaGVkLmxlbmd0aCwgMSk7XG4gICAgICBjb25zdCBkaXNwYXRjaCA9IGRpc3BhdGNoZWRbMF07XG4gICAgICBhc3NlcnQuZXF1YWwoZGlzcGF0Y2guY3VzdG9tVHlwZSwgXCJnc2QtZGVidWctZGlhZ25vc2VcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoZGlzcGF0Y2guZGlzcGxheSwgZmFsc2UpO1xuICAgICAgLy8gR29hbCBsaW5lIG11c3QgY2Fycnkgcm9vdC1jYXVzZS1vbmx5IHZhbHVlXG4gICAgICBhc3NlcnQubWF0Y2goZGlzcGF0Y2guY29udGVudCwgL2BmaW5kX3Jvb3RfY2F1c2Vfb25seWAvKTtcbiAgICAgIC8vIGRvLU5PVC1maXggaW5zdHJ1Y3Rpb24gbXVzdCBiZSBwcmVzZW50XG4gICAgICBhc3NlcnQubWF0Y2goZGlzcGF0Y2guY29udGVudCwgL2RvIFxcKlxcKk5PVFxcKlxcKiBhcHBseSBjb2RlIGNoYW5nZXMvKTtcbiAgICAgIGFzc2VydC5tYXRjaChkaXNwYXRjaC5jb250ZW50LCAvbWVtb3J5LWxlYWstaW4td29ya2VyLXBvb2wvKTtcbiAgICAgIGFzc2VydC5tYXRjaChkaXNwYXRjaC5jb250ZW50LCAvbWVtb3J5IGxlYWsgaW4gd29ya2VyIHBvb2wvKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcHJvY2Vzcy5jaGRpcihzYXZlZCk7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImRpYWdub3NlLWlzc3VlIGRpc3BhdGNoIG5ldmVyIGFkdmVydGlzZXMgZml4LWFwcGxpY2F0aW9uIGluIHBheWxvYWRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIGNvbnN0IGRpc3BhdGNoZWQ6IEFycmF5PHsgY29udGVudDogc3RyaW5nIH0+ID0gW107XG4gICAgY29uc3QgbW9ja1BpID0ge1xuICAgICAgc2VuZE1lc3NhZ2UobXNnOiB7IGN1c3RvbVR5cGU6IHN0cmluZzsgY29udGVudDogc3RyaW5nOyBkaXNwbGF5OiBib29sZWFuIH0pIHtcbiAgICAgICAgZGlzcGF0Y2hlZC5wdXNoKG1zZyk7XG4gICAgICB9LFxuICAgIH07XG4gICAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmN3ZCgpO1xuICAgIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgICB0cnkge1xuICAgICAgYXdhaXQgaGFuZGxlRGVidWcoXCItLWRpYWdub3NlIGZsYWt5IGNoZWNrb3V0IGZsb3cgYWZ0ZXIgcGF5bWVudFwiLCBjcmVhdGVNb2NrQ3R4KCkgYXMgYW55LCBtb2NrUGkgYXMgYW55KTtcbiAgICAgIGFzc2VydC5lcXVhbChkaXNwYXRjaGVkLmxlbmd0aCwgMSk7XG4gICAgICAvLyBHb2FsIG11c3QgYmUgcm9vdC1jYXVzZS1vbmx5IGFuZCBpbmNsdWRlIG5vLWZpeCBpbnN0cnVjdGlvblxuICAgICAgYXNzZXJ0Lm1hdGNoKGRpc3BhdGNoZWRbMF0uY29udGVudCwgL2BmaW5kX3Jvb3RfY2F1c2Vfb25seWAvKTtcbiAgICAgIGFzc2VydC5tYXRjaChkaXNwYXRjaGVkWzBdLmNvbnRlbnQsIC9kbyBcXCpcXCpOT1RcXCpcXCogYXBwbHkgY29kZSBjaGFuZ2VzLyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHByb2Nlc3MuY2hkaXIoc2F2ZWQpO1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJjb250aW51ZSBkaXNwYXRjaGVzIGZpbmRfYW5kX2ZpeCBnb2FsIHNjb3BlZCB0byB0aGUgdGFyZ2V0IHNsdWcgb25seVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgY29uc3QgY3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuICAgIGNvbnN0IGRpc3BhdGNoZWQ6IEFycmF5PHsgY3VzdG9tVHlwZTogc3RyaW5nOyBjb250ZW50OiBzdHJpbmc7IGRpc3BsYXk6IGJvb2xlYW4gfT4gPSBbXTtcbiAgICBjb25zdCBtb2NrUGkgPSB7XG4gICAgICBzZW5kTWVzc2FnZShtc2c6IHsgY3VzdG9tVHlwZTogc3RyaW5nOyBjb250ZW50OiBzdHJpbmc7IGRpc3BsYXk6IGJvb2xlYW4gfSkge1xuICAgICAgICBkaXNwYXRjaGVkLnB1c2gobXNnKTtcbiAgICAgIH0sXG4gICAgfTtcbiAgICBjb25zdCBzYXZlZCA9IHByb2Nlc3MuY3dkKCk7XG4gICAgcHJvY2Vzcy5jaGRpcihiYXNlKTtcblxuICAgIHRyeSB7XG4gICAgICBjcmVhdGVEZWJ1Z1Nlc3Npb24oYmFzZSwgeyBpc3N1ZTogXCJBdXRoIHRpbWVvdXRcIiwgY3JlYXRlZEF0OiAxMCwgc3RhdHVzOiBcInBhdXNlZFwiLCBwaGFzZTogXCJibG9ja2VkXCIgfSk7XG4gICAgICBjcmVhdGVEZWJ1Z1Nlc3Npb24oYmFzZSwgeyBpc3N1ZTogXCJCaWxsaW5nIHdlYmhvb2tcIiwgY3JlYXRlZEF0OiAyMCwgc3RhdHVzOiBcInBhdXNlZFwiLCBwaGFzZTogXCJibG9ja2VkXCIgfSk7XG5cbiAgICAgIGF3YWl0IGhhbmRsZURlYnVnKFwiY29udGludWUgYXV0aC10aW1lb3V0XCIsIGN0eCBhcyBhbnksIG1vY2tQaSBhcyBhbnkpO1xuICAgICAgLy8gTm90aWZpY2F0aW9uIHNob3dzIGRpc3BhdGNoZWQgbW9kZVxuICAgICAgYXNzZXJ0Lm1hdGNoKGN0eC5ub3RpZmljYXRpb25zWzBdLm1lc3NhZ2UsIC9kaXNwYXRjaE1vZGU9ZmluZF9hbmRfZml4Lyk7XG5cbiAgICAgIC8vIEV4YWN0bHkgb25lIGRpc3BhdGNoIGZvciB0aGUgdGFyZ2V0ZWQgc2x1Z1xuICAgICAgYXNzZXJ0LmVxdWFsKGRpc3BhdGNoZWQubGVuZ3RoLCAxKTtcbiAgICAgIGNvbnN0IGRpc3BhdGNoID0gZGlzcGF0Y2hlZFswXTtcbiAgICAgIGFzc2VydC5lcXVhbChkaXNwYXRjaC5jdXN0b21UeXBlLCBcImdzZC1kZWJ1Zy1jb250aW51ZVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChkaXNwYXRjaC5kaXNwbGF5LCBmYWxzZSk7XG4gICAgICAvLyBHb2FsIGxpbmUgbXVzdCBjYXJyeSBmaW5kLWFuZC1maXggdmFsdWVcbiAgICAgIGFzc2VydC5tYXRjaChkaXNwYXRjaC5jb250ZW50LCAvYGZpbmRfYW5kX2ZpeGAvKTtcbiAgICAgIC8vIFNlc3Npb24gc2x1ZyBpcyBzY29wZWQgY29ycmVjdGx5XG4gICAgICBhc3NlcnQubWF0Y2goZGlzcGF0Y2guY29udGVudCwgL2F1dGgtdGltZW91dC8pO1xuICAgICAgLy8gTXVzdCBOT1QgbWVudGlvbiB0aGUgb3RoZXIgc2Vzc2lvbiBzbHVnIFx1MjAxNCBubyBjcm9zcy1zZXNzaW9uIGJsZWVkXG4gICAgICBhc3NlcnQuZG9lc05vdE1hdGNoKGRpc3BhdGNoLmNvbnRlbnQsIC9iaWxsaW5nLXdlYmhvb2svKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcHJvY2Vzcy5jaGRpcihzYXZlZCk7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImNvbnRpbnVlIGRpc3BhdGNoIGZhaWx1cmUgc3VyZmFjZXMgd2FybmluZyB3aXRob3V0IGNvcnJ1cHRpbmcgc2Vzc2lvbiBzdGF0ZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgY29uc3QgY3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuICAgIGNvbnN0IG1vY2tQaSA9IHtcbiAgICAgIHNlbmRNZXNzYWdlKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJ0cmFuc3BvcnQgdW5hdmFpbGFibGVcIik7XG4gICAgICB9LFxuICAgIH07XG4gICAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmN3ZCgpO1xuICAgIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgICB0cnkge1xuICAgICAgY3JlYXRlRGVidWdTZXNzaW9uKGJhc2UsIHsgaXNzdWU6IFwiQ0kgZmxha2VcIiwgY3JlYXRlZEF0OiAxMCwgc3RhdHVzOiBcInBhdXNlZFwiLCBwaGFzZTogXCJibG9ja2VkXCIgfSk7XG5cbiAgICAgIGF3YWl0IGhhbmRsZURlYnVnKFwiY29udGludWUgY2ktZmxha2VcIiwgY3R4IGFzIGFueSwgbW9ja1BpIGFzIGFueSk7XG4gICAgICAvLyBTZXNzaW9uIHVwZGF0ZSBub3RpZmljYXRpb24gc3RpbGwgZmlyZXMgZmlyc3RcbiAgICAgIGFzc2VydC5tYXRjaChjdHgubm90aWZpY2F0aW9uc1swXS5tZXNzYWdlLCAvUmVzdW1lZCBkZWJ1ZyBzZXNzaW9uLyk7XG5cbiAgICAgIC8vIERpc3BhdGNoIGVycm9yIG5vdGlmaWNhdGlvbiBmb2xsb3dzXG4gICAgICBhc3NlcnQuZXF1YWwoY3R4Lm5vdGlmaWNhdGlvbnMubGVuZ3RoLCAyKTtcbiAgICAgIGFzc2VydC5lcXVhbChjdHgubm90aWZpY2F0aW9uc1sxXS5sZXZlbCwgXCJ3YXJuaW5nXCIpO1xuICAgICAgYXNzZXJ0Lm1hdGNoKGN0eC5ub3RpZmljYXRpb25zWzFdLm1lc3NhZ2UsIC9Db250aW51ZSBkaXNwYXRjaCBmYWlsZWQvKTtcbiAgICAgIGFzc2VydC5tYXRjaChjdHgubm90aWZpY2F0aW9uc1sxXS5tZXNzYWdlLCAvY2ktZmxha2UvKTtcblxuICAgICAgLy8gU2Vzc2lvbiBzdGF0ZSB3YXMgcGVyc2lzdGVkIGRlc3BpdGUgZGlzcGF0Y2ggZmFpbHVyZVxuICAgICAgY29uc3Qgc3RhdHVzQ3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuICAgICAgYXdhaXQgaGFuZGxlRGVidWcoXCJzdGF0dXMgY2ktZmxha2VcIiwgc3RhdHVzQ3R4IGFzIGFueSk7XG4gICAgICBhc3NlcnQubWF0Y2goc3RhdHVzQ3R4Lm5vdGlmaWNhdGlvbnNbMF0ubWVzc2FnZSwgL3N0YXR1cz1hY3RpdmUvKTtcbiAgICAgIGFzc2VydC5tYXRjaChzdGF0dXNDdHgubm90aWZpY2F0aW9uc1swXS5tZXNzYWdlLCAvcGhhc2U9Y29udGludWVkLyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHByb2Nlc3MuY2hkaXIoc2F2ZWQpO1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJkaWFnbm9zZS1pc3N1ZSBkaXNwYXRjaCBmYWlsdXJlIHN1cmZhY2VzIHdhcm5pbmcgd2l0aG91dCBsb3Npbmcgc2Vzc2lvblwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgY29uc3QgY3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuICAgIGNvbnN0IG1vY2tQaSA9IHtcbiAgICAgIHNlbmRNZXNzYWdlKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJkaXNwYXRjaCBlcnJvclwiKTtcbiAgICAgIH0sXG4gICAgfTtcbiAgICBjb25zdCBzYXZlZCA9IHByb2Nlc3MuY3dkKCk7XG4gICAgcHJvY2Vzcy5jaGRpcihiYXNlKTtcblxuICAgIHRyeSB7XG4gICAgICBhd2FpdCBoYW5kbGVEZWJ1ZyhcIi0tZGlhZ25vc2UgYXV0aCB0b2tlbiBleHBpcnkgcmFjZSBjb25kaXRpb25cIiwgY3R4IGFzIGFueSwgbW9ja1BpIGFzIGFueSk7XG4gICAgICAvLyBGaXJzdCBub3RpZmljYXRpb246IHNlc3Npb24gY3JlYXRlZFxuICAgICAgYXNzZXJ0LmVxdWFsKGN0eC5ub3RpZmljYXRpb25zWzBdLmxldmVsLCBcImluZm9cIik7XG4gICAgICBhc3NlcnQubWF0Y2goY3R4Lm5vdGlmaWNhdGlvbnNbMF0ubWVzc2FnZSwgL0RpYWdub3NlIHNlc3Npb24gc3RhcnRlZC8pO1xuXG4gICAgICAvLyBTZWNvbmQgbm90aWZpY2F0aW9uOiBkaXNwYXRjaCBlcnJvclxuICAgICAgYXNzZXJ0LmVxdWFsKGN0eC5ub3RpZmljYXRpb25zLmxlbmd0aCwgMik7XG4gICAgICBhc3NlcnQuZXF1YWwoY3R4Lm5vdGlmaWNhdGlvbnNbMV0ubGV2ZWwsIFwid2FybmluZ1wiKTtcbiAgICAgIGFzc2VydC5tYXRjaChjdHgubm90aWZpY2F0aW9uc1sxXS5tZXNzYWdlLCAvRGlhZ25vc2UgZGlzcGF0Y2ggZmFpbGVkLyk7XG4gICAgICBhc3NlcnQubWF0Y2goY3R4Lm5vdGlmaWNhdGlvbnNbMV0ubWVzc2FnZSwgL2F1dGgtdG9rZW4tZXhwaXJ5LXJhY2UtY29uZGl0aW9uLyk7XG5cbiAgICAgIC8vIFNlc3Npb24gYXJ0aWZhY3Qgc3RpbGwgZXhpc3RzXG4gICAgICBjb25zdCBzdGF0dXNDdHggPSBjcmVhdGVNb2NrQ3R4KCk7XG4gICAgICBhd2FpdCBoYW5kbGVEZWJ1ZyhcInN0YXR1cyBhdXRoLXRva2VuLWV4cGlyeS1yYWNlLWNvbmRpdGlvblwiLCBzdGF0dXNDdHggYXMgYW55KTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0dXNDdHgubm90aWZpY2F0aW9uc1swXS5sZXZlbCwgXCJpbmZvXCIpO1xuICAgICAgYXNzZXJ0Lm1hdGNoKHN0YXR1c0N0eC5ub3RpZmljYXRpb25zWzBdLm1lc3NhZ2UsIC9tb2RlPWRpYWdub3NlLyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHByb2Nlc3MuY2hkaXIoc2F2ZWQpO1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJjb250aW51ZSB3aXRoIHVua25vd24gc2x1ZyBlbWl0cyB3YXJuaW5nIHdpdGhvdXQgZGlzcGF0Y2hpbmdcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIGNvbnN0IGN0eCA9IGNyZWF0ZU1vY2tDdHgoKTtcbiAgICBjb25zdCBkaXNwYXRjaGVkOiBBcnJheTx1bmtub3duPiA9IFtdO1xuICAgIGNvbnN0IG1vY2tQaSA9IHtcbiAgICAgIHNlbmRNZXNzYWdlKG1zZzogdW5rbm93bikgeyBkaXNwYXRjaGVkLnB1c2gobXNnKTsgfSxcbiAgICB9O1xuICAgIGNvbnN0IHNhdmVkID0gcHJvY2Vzcy5jd2QoKTtcbiAgICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGhhbmRsZURlYnVnKFwiY29udGludWUgbm8tc3VjaC1zbHVnXCIsIGN0eCBhcyBhbnksIG1vY2tQaSBhcyBhbnkpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGN0eC5ub3RpZmljYXRpb25zWzBdLmxldmVsLCBcIndhcm5pbmdcIik7XG4gICAgICBhc3NlcnQubWF0Y2goY3R4Lm5vdGlmaWNhdGlvbnNbMF0ubWVzc2FnZSwgL1Vua25vd24gZGVidWcgc2Vzc2lvbiBzbHVnLyk7XG4gICAgICBhc3NlcnQuZXF1YWwoZGlzcGF0Y2hlZC5sZW5ndGgsIDApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmNoZGlyKHNhdmVkKTtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiZGlhZ25vc2UtaXNzdWUgd2l0aCBpc3N1ZSB0ZXh0IGNvbnRhaW5pbmcgcmVzZXJ2ZWQgY29tbWFuZCB3b3JkcyBkaXNwYXRjaGVzIGNvcnJlY3RseVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgY29uc3QgZGlzcGF0Y2hlZDogQXJyYXk8eyBjb250ZW50OiBzdHJpbmcgfT4gPSBbXTtcbiAgICBjb25zdCBtb2NrUGkgPSB7XG4gICAgICBzZW5kTWVzc2FnZShtc2c6IHsgY3VzdG9tVHlwZTogc3RyaW5nOyBjb250ZW50OiBzdHJpbmc7IGRpc3BsYXk6IGJvb2xlYW4gfSkge1xuICAgICAgICBkaXNwYXRjaGVkLnB1c2gobXNnKTtcbiAgICAgIH0sXG4gICAgfTtcbiAgICBjb25zdCBzYXZlZCA9IHByb2Nlc3MuY3dkKCk7XG4gICAgcHJvY2Vzcy5jaGRpcihiYXNlKTtcblxuICAgIHRyeSB7XG4gICAgICAvLyAnc3RhdHVzJyBhbmQgJ2NvbnRpbnVlJyBhcmUgcmVzZXJ2ZWQgd29yZHMgYnV0IGluIG11bHRpLXRva2VuIC0tZGlhZ25vc2UgY29udGV4dCB0aGV5IGJlY29tZSBpc3N1ZSB0ZXh0XG4gICAgICBhd2FpdCBoYW5kbGVEZWJ1ZyhcIi0tZGlhZ25vc2Ugc3RhdHVzIGVuZHBvaW50IGNvbnRpbnVlcyB0byByZXR1cm4gNTAwXCIsIGNyZWF0ZU1vY2tDdHgoKSBhcyBhbnksIG1vY2tQaSBhcyBhbnkpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGRpc3BhdGNoZWQubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5tYXRjaChkaXNwYXRjaGVkWzBdLmNvbnRlbnQsIC9maW5kX3Jvb3RfY2F1c2Vfb25seS8pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKGRpc3BhdGNoZWRbMF0uY29udGVudCwgL3N0YXR1cy1lbmRwb2ludC1jb250aW51ZXMtdG8tcmV0dXJuLTUwMC8pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmNoZGlyKHNhdmVkKTtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiY29udGludWUgd2l0aCBjaGVja3BvaW50IHN0YXRlIGRpc3BhdGNoZXMgZGVidWctc2Vzc2lvbi1tYW5hZ2VyIHRlbXBsYXRlIHdpdGggY2hlY2twb2ludCBjb250ZXh0XCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgICBjb25zdCBjdHggPSBjcmVhdGVNb2NrQ3R4KCk7XG4gICAgY29uc3QgZGlzcGF0Y2hlZDogQXJyYXk8eyBjdXN0b21UeXBlOiBzdHJpbmc7IGNvbnRlbnQ6IHN0cmluZzsgZGlzcGxheTogYm9vbGVhbiB9PiA9IFtdO1xuICAgIGNvbnN0IG1vY2tQaSA9IHtcbiAgICAgIHNlbmRNZXNzYWdlKG1zZzogeyBjdXN0b21UeXBlOiBzdHJpbmc7IGNvbnRlbnQ6IHN0cmluZzsgZGlzcGxheTogYm9vbGVhbiB9KSB7XG4gICAgICAgIGRpc3BhdGNoZWQucHVzaChtc2cpO1xuICAgICAgfSxcbiAgICB9O1xuICAgIGNvbnN0IHNhdmVkID0gcHJvY2Vzcy5jd2QoKTtcbiAgICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNyZWF0ZURlYnVnU2Vzc2lvbihiYXNlLCB7IGlzc3VlOiBcIkF1dGggdGltZW91dFwiLCBjcmVhdGVkQXQ6IDEwIH0pO1xuICAgICAgdXBkYXRlRGVidWdTZXNzaW9uKGJhc2UsIFwiYXV0aC10aW1lb3V0XCIsIHtcbiAgICAgICAgY2hlY2twb2ludDoge1xuICAgICAgICAgIHR5cGU6IFwiaHVtYW4tdmVyaWZ5XCIsXG4gICAgICAgICAgc3VtbWFyeTogXCJDb25maXJtIHRoZSBuZXR3b3JrIHRyYWNlIHNob3dzIHRoZSByaWdodCBoZWFkZXJzXCIsXG4gICAgICAgICAgYXdhaXRpbmdSZXNwb25zZTogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuXG4gICAgICBhd2FpdCBoYW5kbGVEZWJ1ZyhcImNvbnRpbnVlIGF1dGgtdGltZW91dFwiLCBjdHggYXMgYW55LCBtb2NrUGkgYXMgYW55KTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKGRpc3BhdGNoZWQubGVuZ3RoLCAxKTtcbiAgICAgIGNvbnN0IGRpc3BhdGNoID0gZGlzcGF0Y2hlZFswXTtcbiAgICAgIGFzc2VydC5lcXVhbChkaXNwYXRjaC5jdXN0b21UeXBlLCBcImdzZC1kZWJ1Zy1jb250aW51ZVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChkaXNwYXRjaC5kaXNwbGF5LCBmYWxzZSk7XG4gICAgICAvLyBVc2VzIGRlYnVnLXNlc3Npb24tbWFuYWdlciB0ZW1wbGF0ZSAoaGFzIHN0cnVjdHVyZWQgcmV0dXJuIGhlYWRlcnMpXG4gICAgICBhc3NlcnQubWF0Y2goZGlzcGF0Y2guY29udGVudCwgLyMjIENIRUNLUE9JTlQgUkVBQ0hFRC8pO1xuICAgICAgLy8gQ2hlY2twb2ludCBjb250ZXh0IGlzIHBvcHVsYXRlZFxuICAgICAgYXNzZXJ0Lm1hdGNoKGRpc3BhdGNoLmNvbnRlbnQsIC8jIyBBY3RpdmUgQ2hlY2twb2ludC8pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKGRpc3BhdGNoLmNvbnRlbnQsIC90eXBlOiBodW1hbi12ZXJpZnkvKTtcbiAgICAgIGFzc2VydC5tYXRjaChkaXNwYXRjaC5jb250ZW50LCAvQ29uZmlybSB0aGUgbmV0d29yayB0cmFjZS8pO1xuICAgICAgLy8gTm90aWZpY2F0aW9uIGluY2x1ZGVzIGNoZWNrcG9pbnQgaGludFxuICAgICAgYXNzZXJ0Lm1hdGNoKGN0eC5ub3RpZmljYXRpb25zWzBdLm1lc3NhZ2UsIC9jaGVja3BvaW50VHlwZT1odW1hbi12ZXJpZnkvKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcHJvY2Vzcy5jaGRpcihzYXZlZCk7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImNvbnRpbnVlIHdpdGggVEREIGdhdGUgcGVuZGluZyBkaXNwYXRjaGVzIGZpbmRfcm9vdF9jYXVzZV9vbmx5IGFuZCBkb2VzIG5vdCBkaXNwYXRjaCBmaW5kX2FuZF9maXhcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIGNvbnN0IGN0eCA9IGNyZWF0ZU1vY2tDdHgoKTtcbiAgICBjb25zdCBkaXNwYXRjaGVkOiBBcnJheTx7IGN1c3RvbVR5cGU6IHN0cmluZzsgY29udGVudDogc3RyaW5nOyBkaXNwbGF5OiBib29sZWFuIH0+ID0gW107XG4gICAgY29uc3QgbW9ja1BpID0ge1xuICAgICAgc2VuZE1lc3NhZ2UobXNnOiB7IGN1c3RvbVR5cGU6IHN0cmluZzsgY29udGVudDogc3RyaW5nOyBkaXNwbGF5OiBib29sZWFuIH0pIHtcbiAgICAgICAgZGlzcGF0Y2hlZC5wdXNoKG1zZyk7XG4gICAgICB9LFxuICAgIH07XG4gICAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmN3ZCgpO1xuICAgIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgICB0cnkge1xuICAgICAgY3JlYXRlRGVidWdTZXNzaW9uKGJhc2UsIHsgaXNzdWU6IFwiRmxha3kgYXV0aFwiLCBjcmVhdGVkQXQ6IDEwIH0pO1xuICAgICAgdXBkYXRlRGVidWdTZXNzaW9uKGJhc2UsIFwiZmxha3ktYXV0aFwiLCB7XG4gICAgICAgIHRkZEdhdGU6IHsgZW5hYmxlZDogdHJ1ZSwgcGhhc2U6IFwicGVuZGluZ1wiLCB0ZXN0RmlsZTogXCJhdXRoLnRlc3QudHNcIiB9LFxuICAgICAgfSk7XG5cbiAgICAgIGF3YWl0IGhhbmRsZURlYnVnKFwiY29udGludWUgZmxha3ktYXV0aFwiLCBjdHggYXMgYW55LCBtb2NrUGkgYXMgYW55KTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKGRpc3BhdGNoZWQubGVuZ3RoLCAxKTtcbiAgICAgIGNvbnN0IGRpc3BhdGNoID0gZGlzcGF0Y2hlZFswXTtcbiAgICAgIC8vIEFjdGl2ZSBnb2FsIGxpbmUgbXVzdCBiZSBmaW5kX3Jvb3RfY2F1c2Vfb25seSBcdTIwMTQgdGhlIHRlbXBsYXRlIGFsd2F5cyBsaXN0cyBib3RoIGdvYWwgbmFtZXMgaW5cbiAgICAgIC8vIGl0cyBzZW1hbnRpY3Mgc2VjdGlvbiwgc28gd2UgY2hlY2sgdGhlIHNwZWNpZmljIFwiIyMgR29hbFxcbmBcdTIwMjZgXCIgbGluZSwgbm90IHRoZSB3aG9sZSBjb250ZW50LlxuICAgICAgYXNzZXJ0Lm1hdGNoKGRpc3BhdGNoLmNvbnRlbnQsIC8jIyBHb2FsXFxzK2BmaW5kX3Jvb3RfY2F1c2Vfb25seWAvKTtcbiAgICAgIGFzc2VydC5kb2VzTm90TWF0Y2goZGlzcGF0Y2guY29udGVudCwgLyMjIEdvYWxcXHMrYGZpbmRfYW5kX2ZpeGAvKTtcbiAgICAgIC8vIFRERCBjb250ZXh0IGFwcGVhcnNcbiAgICAgIGFzc2VydC5tYXRjaChkaXNwYXRjaC5jb250ZW50LCAvVEREIEdhdGUvKTtcbiAgICAgIGFzc2VydC5tYXRjaChkaXNwYXRjaC5jb250ZW50LCAvcGhhc2U6IHBlbmRpbmcvKTtcbiAgICAgIC8vIE5vdGlmaWNhdGlvbiBzaG93cyBUREQgaGludFxuICAgICAgYXNzZXJ0Lm1hdGNoKGN0eC5ub3RpZmljYXRpb25zWzBdLm1lc3NhZ2UsIC90ZGRQaGFzZT1wZW5kaW5nLyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHByb2Nlc3MuY2hkaXIoc2F2ZWQpO1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJjb250aW51ZSB3aXRoIFRERCBnYXRlIHJlZCBkaXNwYXRjaGVzIGZpbmRfYW5kX2ZpeCBhbmQgYWR2YW5jZXMgcGhhc2UgdG8gZ3JlZW4gYmVmb3JlIGRpc3BhdGNoXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgICBjb25zdCBjdHggPSBjcmVhdGVNb2NrQ3R4KCk7XG4gICAgY29uc3QgZGlzcGF0Y2hlZDogQXJyYXk8eyBjdXN0b21UeXBlOiBzdHJpbmc7IGNvbnRlbnQ6IHN0cmluZzsgZGlzcGxheTogYm9vbGVhbiB9PiA9IFtdO1xuICAgIGNvbnN0IG1vY2tQaSA9IHtcbiAgICAgIHNlbmRNZXNzYWdlKG1zZzogeyBjdXN0b21UeXBlOiBzdHJpbmc7IGNvbnRlbnQ6IHN0cmluZzsgZGlzcGxheTogYm9vbGVhbiB9KSB7XG4gICAgICAgIGRpc3BhdGNoZWQucHVzaChtc2cpO1xuICAgICAgfSxcbiAgICB9O1xuICAgIGNvbnN0IHNhdmVkID0gcHJvY2Vzcy5jd2QoKTtcbiAgICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNyZWF0ZURlYnVnU2Vzc2lvbihiYXNlLCB7IGlzc3VlOiBcIkNhY2hlIG1pc3NcIiwgY3JlYXRlZEF0OiAxMCB9KTtcbiAgICAgIHVwZGF0ZURlYnVnU2Vzc2lvbihiYXNlLCBcImNhY2hlLW1pc3NcIiwge1xuICAgICAgICB0ZGRHYXRlOiB7XG4gICAgICAgICAgZW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICBwaGFzZTogXCJyZWRcIixcbiAgICAgICAgICB0ZXN0RmlsZTogXCJjYWNoZS50ZXN0LnRzXCIsXG4gICAgICAgICAgdGVzdE5hbWU6IFwicmV0dXJucyBzdGFsZSBlbnRyeVwiLFxuICAgICAgICAgIGZhaWx1cmVPdXRwdXQ6IFwiRXhwZWN0ZWQgJ2ZyZXNoJyB0byBlcXVhbCAnc3RhbGUnXCIsXG4gICAgICAgIH0sXG4gICAgICB9KTtcblxuICAgICAgYXdhaXQgaGFuZGxlRGVidWcoXCJjb250aW51ZSBjYWNoZS1taXNzXCIsIGN0eCBhcyBhbnksIG1vY2tQaSBhcyBhbnkpO1xuXG4gICAgICAvLyBEaXNwYXRjaCB1c2VzIGZpbmRfYW5kX2ZpeFxuICAgICAgYXNzZXJ0LmVxdWFsKGRpc3BhdGNoZWQubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5tYXRjaChkaXNwYXRjaGVkWzBdLmNvbnRlbnQsIC9gZmluZF9hbmRfZml4YC8pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKGRpc3BhdGNoZWRbMF0uY29udGVudCwgL1RERCBHYXRlLyk7XG4gICAgICBhc3NlcnQubWF0Y2goZGlzcGF0Y2hlZFswXS5jb250ZW50LCAvcmVkIFx1MjE5MiBncmVlbi8pO1xuICAgICAgLy8gU2Vzc2lvbiBhcnRpZmFjdCBtdXN0IGhhdmUgdGRkR2F0ZS5waGFzZSA9PT0gXCJncmVlblwiIGFmdGVyIGRpc3BhdGNoXG4gICAgICBjb25zdCBzdGF0dXNDdHggPSBjcmVhdGVNb2NrQ3R4KCk7XG4gICAgICBhd2FpdCBoYW5kbGVEZWJ1ZyhcInN0YXR1cyBjYWNoZS1taXNzXCIsIHN0YXR1c0N0eCBhcyBhbnkpO1xuICAgICAgLy8gTG9hZCB0aGUgYXJ0aWZhY3QgZGlyZWN0bHkgdG8gdmVyaWZ5IHBoYXNlIHdhcyB1cGRhdGVkXG4gICAgICBjb25zdCB7IGxvYWREZWJ1Z1Nlc3Npb246IGxvYWQgfSA9IGF3YWl0IGltcG9ydChcIi4uL2RlYnVnLXNlc3Npb24tc3RvcmUudHNcIik7XG4gICAgICBjb25zdCByZWNvcmQgPSBsb2FkKGJhc2UsIFwiY2FjaGUtbWlzc1wiKTtcbiAgICAgIGFzc2VydC5vayhyZWNvcmQgIT0gbnVsbCk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVjb3JkIS5zZXNzaW9uLnRkZEdhdGU/LnBoYXNlLCBcImdyZWVuXCIpO1xuICAgICAgLy8gTm90aWZpY2F0aW9uIHNob3dzIHJlZFx1MjE5MmdyZWVuIHRyYW5zaXRpb25cbiAgICAgIGFzc2VydC5tYXRjaChjdHgubm90aWZpY2F0aW9uc1swXS5tZXNzYWdlLCAvdGRkUGhhc2U9cmVkXHUyMTkyZ3JlZW4vKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcHJvY2Vzcy5jaGRpcihzYXZlZCk7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImNvbnRpbnVlIHdpdGhvdXQgY2hlY2twb2ludCBvciBUREQgZ2F0ZSB1c2VzIGRlYnVnLWRpYWdub3NlIHRlbXBsYXRlIHdpdGggZmluZF9hbmRfZml4IChyZWdyZXNzaW9uIGd1YXJkKVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgY29uc3QgY3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuICAgIGNvbnN0IGRpc3BhdGNoZWQ6IEFycmF5PHsgY3VzdG9tVHlwZTogc3RyaW5nOyBjb250ZW50OiBzdHJpbmc7IGRpc3BsYXk6IGJvb2xlYW4gfT4gPSBbXTtcbiAgICBjb25zdCBtb2NrUGkgPSB7XG4gICAgICBzZW5kTWVzc2FnZShtc2c6IHsgY3VzdG9tVHlwZTogc3RyaW5nOyBjb250ZW50OiBzdHJpbmc7IGRpc3BsYXk6IGJvb2xlYW4gfSkge1xuICAgICAgICBkaXNwYXRjaGVkLnB1c2gobXNnKTtcbiAgICAgIH0sXG4gICAgfTtcbiAgICBjb25zdCBzYXZlZCA9IHByb2Nlc3MuY3dkKCk7XG4gICAgcHJvY2Vzcy5jaGRpcihiYXNlKTtcblxuICAgIHRyeSB7XG4gICAgICBjcmVhdGVEZWJ1Z1Nlc3Npb24oYmFzZSwgeyBpc3N1ZTogXCJMb2dpbiBicm9rZW5cIiwgY3JlYXRlZEF0OiAxMCwgc3RhdHVzOiBcInBhdXNlZFwiLCBwaGFzZTogXCJibG9ja2VkXCIgfSk7XG5cbiAgICAgIGF3YWl0IGhhbmRsZURlYnVnKFwiY29udGludWUgbG9naW4tYnJva2VuXCIsIGN0eCBhcyBhbnksIG1vY2tQaSBhcyBhbnkpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoZGlzcGF0Y2hlZC5sZW5ndGgsIDEpO1xuICAgICAgY29uc3QgZGlzcGF0Y2ggPSBkaXNwYXRjaGVkWzBdO1xuICAgICAgYXNzZXJ0LmVxdWFsKGRpc3BhdGNoLmN1c3RvbVR5cGUsIFwiZ3NkLWRlYnVnLWNvbnRpbnVlXCIpO1xuICAgICAgLy8gUGxhaW4gY29udGludWUgdXNlcyBkZWJ1Zy1kaWFnbm9zZSBcdTIwMTQgbm8gc3RydWN0dXJlZCByZXR1cm4gaGVhZGVycyBsaWtlICMjIFRERCBDSEVDS1BPSU5UXG4gICAgICBhc3NlcnQubWF0Y2goZGlzcGF0Y2guY29udGVudCwgL2BmaW5kX2FuZF9maXhgLyk7XG4gICAgICBhc3NlcnQuZG9lc05vdE1hdGNoKGRpc3BhdGNoLmNvbnRlbnQsIC8jIyBBY3RpdmUgQ2hlY2twb2ludC8pO1xuICAgICAgYXNzZXJ0LmRvZXNOb3RNYXRjaChkaXNwYXRjaC5jb250ZW50LCAvIyMgVEREIEdhdGUvKTtcbiAgICAgIC8vIE5vdGlmaWNhdGlvbiBzaG93cyBwbGFpbiBkaXNwYXRjaE1vZGVcbiAgICAgIGFzc2VydC5tYXRjaChjdHgubm90aWZpY2F0aW9uc1swXS5tZXNzYWdlLCAvZGlzcGF0Y2hNb2RlPWZpbmRfYW5kX2ZpeC8pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmNoZGlyKHNhdmVkKTtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcImRlYnVnLXNlc3Npb24tbWFuYWdlciBwcm9tcHQgdGVtcGxhdGVcIiwgKCkgPT4ge1xuICB0ZXN0KFwibG9hZFByb21wdCgnZGVidWctc2Vzc2lvbi1tYW5hZ2VyJykgcmV0dXJucyBjb250ZW50IHdpdGggYWxsIHN0cnVjdHVyZWQgcmV0dXJuIGhlYWRlciBrZXl3b3Jkc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgY29udGVudCA9IGxvYWRQcm9tcHQoXCJkZWJ1Zy1zZXNzaW9uLW1hbmFnZXJcIiwge1xuICAgICAgc2x1ZzogXCJhdXRoLWZsYWtlXCIsXG4gICAgICBtb2RlOiBcImRlYnVnXCIsXG4gICAgICBpc3N1ZTogXCJMb2dpbiBmYWlscyBvbiBTYWZhcmlcIixcbiAgICAgIHdvcmtpbmdEaXJlY3Rvcnk6IFwiL3JlcG9cIixcbiAgICAgIGdvYWw6IFwiZmluZF9yb290X2NhdXNlX29ubHlcIixcbiAgICAgIGNoZWNrcG9pbnRDb250ZXh0OiBcIlwiLFxuICAgICAgdGRkQ29udGV4dDogXCJcIixcbiAgICAgIHNwZWNpYWxpc3RDb250ZXh0OiBcIlwiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0Lm1hdGNoKGNvbnRlbnQsIC8jIyBST09UIENBVVNFIEZPVU5ELyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGNvbnRlbnQsIC8jIyBUREQgQ0hFQ0tQT0lOVC8pO1xuICAgIGFzc2VydC5tYXRjaChjb250ZW50LCAvIyMgQ0hFQ0tQT0lOVCBSRUFDSEVELyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGNvbnRlbnQsIC8jIyBERUJVRyBDT01QTEVURS8pO1xuICAgIGFzc2VydC5tYXRjaChjb250ZW50LCAvIyMgSU5WRVNUSUdBVElPTiBJTkNPTkNMVVNJVkUvKTtcbiAgfSk7XG5cbiAgdGVzdChcInRlbXBsYXRlIGNvbnRhaW5zIHNwZWNpYWxpc3QgbWFwcGluZyB0YWJsZSBrZXl3b3Jkc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgY29udGVudCA9IGxvYWRQcm9tcHQoXCJkZWJ1Zy1zZXNzaW9uLW1hbmFnZXJcIiwge1xuICAgICAgc2x1ZzogXCJhdXRoLWZsYWtlXCIsXG4gICAgICBtb2RlOiBcImRlYnVnXCIsXG4gICAgICBpc3N1ZTogXCJMb2dpbiBmYWlscyBvbiBTYWZhcmlcIixcbiAgICAgIHdvcmtpbmdEaXJlY3Rvcnk6IFwiL3JlcG9cIixcbiAgICAgIGdvYWw6IFwiZmluZF9yb290X2NhdXNlX29ubHlcIixcbiAgICAgIGNoZWNrcG9pbnRDb250ZXh0OiBcIlwiLFxuICAgICAgdGRkQ29udGV4dDogXCJcIixcbiAgICAgIHNwZWNpYWxpc3RDb250ZXh0OiBcIlwiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0Lm1hdGNoKGNvbnRlbnQsIC90eXBlc2NyaXB0LWV4cGVydC8pO1xuICAgIGFzc2VydC5tYXRjaChjb250ZW50LCAvc3VwYWJhc2UtcG9zdGdyZXMtYmVzdC1wcmFjdGljZXMvKTtcbiAgICBhc3NlcnQubWF0Y2goY29udGVudCwgL0xPT0tTX0dPT0QvKTtcbiAgICBhc3NlcnQubWF0Y2goY29udGVudCwgL1NVR0dFU1RfQ0hBTkdFLyk7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiY29udGludWUgaGFuZGxlciBcdTIwMTQgc3BlY2lhbGlzdCByZXZpZXcgZGlzcGF0Y2hcIiwgKCkgPT4ge1xuICB0ZXN0KFwiY29udGludWUgd2l0aCBzcGVjaWFsaXN0UmV2aWV3IHByZXNlbnQgXHUyMDE0IGRpc3BhdGNoIHBheWxvYWQgY29udGFpbnMgc3BlY2lhbGlzdCBoaW50IGFuZCB2ZXJkaWN0XCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgICBjb25zdCBjdHggPSBjcmVhdGVNb2NrQ3R4KCk7XG4gICAgY29uc3QgZGlzcGF0Y2hlZDogQXJyYXk8eyBjdXN0b21UeXBlOiBzdHJpbmc7IGNvbnRlbnQ6IHN0cmluZzsgZGlzcGxheTogYm9vbGVhbiB9PiA9IFtdO1xuICAgIGNvbnN0IG1vY2tQaSA9IHtcbiAgICAgIHNlbmRNZXNzYWdlKG1zZzogeyBjdXN0b21UeXBlOiBzdHJpbmc7IGNvbnRlbnQ6IHN0cmluZzsgZGlzcGxheTogYm9vbGVhbiB9KSB7XG4gICAgICAgIGRpc3BhdGNoZWQucHVzaChtc2cpO1xuICAgICAgfSxcbiAgICB9O1xuICAgIGNvbnN0IHNhdmVkID0gcHJvY2Vzcy5jd2QoKTtcbiAgICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNyZWF0ZURlYnVnU2Vzc2lvbihiYXNlLCB7IGlzc3VlOiBcIk51bGwgcG9pbnRlciBvbiBsb2dpblwiLCBjcmVhdGVkQXQ6IDEwIH0pO1xuICAgICAgdXBkYXRlRGVidWdTZXNzaW9uKGJhc2UsIFwibnVsbC1wb2ludGVyLW9uLWxvZ2luXCIsIHtcbiAgICAgICAgY2hlY2twb2ludDogeyB0eXBlOiBcImh1bWFuLWFjdGlvblwiLCBzdW1tYXJ5OiBcIkNoZWNrIERCIHNjaGVtYVwiLCBhd2FpdGluZ1Jlc3BvbnNlOiB0cnVlIH0sXG4gICAgICAgIHNwZWNpYWxpc3RSZXZpZXc6IHtcbiAgICAgICAgICBoaW50OiBcInR5cGVzY3JpcHRcIixcbiAgICAgICAgICBza2lsbDogXCJ0eXBlc2NyaXB0LWV4cGVydFwiLFxuICAgICAgICAgIHZlcmRpY3Q6IFwiU1VHR0VTVF9DSEFOR0VcIixcbiAgICAgICAgICBkZXRhaWw6IFwiVXNlIG9wdGlvbmFsIGNoYWluaW5nIGluc3RlYWQgb2YgbnVsbCBjaGVja3NcIixcbiAgICAgICAgICByZXZpZXdlZEF0OiAxMDAwLFxuICAgICAgICB9LFxuICAgICAgfSk7XG5cbiAgICAgIGF3YWl0IGhhbmRsZURlYnVnKFwiY29udGludWUgbnVsbC1wb2ludGVyLW9uLWxvZ2luXCIsIGN0eCBhcyBhbnksIG1vY2tQaSBhcyBhbnkpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoZGlzcGF0Y2hlZC5sZW5ndGgsIDEpO1xuICAgICAgY29uc3QgY29udGVudCA9IGRpc3BhdGNoZWRbMF0uY29udGVudDtcbiAgICAgIC8vIHNwZWNpYWxpc3RDb250ZXh0IGJsb2NrIGFwcGVhcnMgaW4gdGhlIGRpc3BhdGNoXG4gICAgICBhc3NlcnQubWF0Y2goY29udGVudCwgL1ByaW9yIFNwZWNpYWxpc3QgUmV2aWV3Lyk7XG4gICAgICBhc3NlcnQubWF0Y2goY29udGVudCwgL2hpbnQ6IHR5cGVzY3JpcHQvKTtcbiAgICAgIGFzc2VydC5tYXRjaChjb250ZW50LCAvdmVyZGljdDogU1VHR0VTVF9DSEFOR0UvKTtcbiAgICAgIGFzc2VydC5tYXRjaChjb250ZW50LCAvVXNlIG9wdGlvbmFsIGNoYWluaW5nLyk7XG4gICAgICAvLyBOb3RpZmljYXRpb24gaW5jbHVkZXMgc3BlY2lhbGlzdEhpbnQgbGFiZWxcbiAgICAgIGFzc2VydC5tYXRjaChjdHgubm90aWZpY2F0aW9uc1swXS5tZXNzYWdlLCAvc3BlY2lhbGlzdEhpbnQ9dHlwZXNjcmlwdC8pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmNoZGlyKHNhdmVkKTtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiY29udGludWUgd2l0aCBzcGVjaWFsaXN0UmV2aWV3IGFic2VudCBcdTIwMTQgc3BlY2lhbGlzdENvbnRleHQgaXMgZW1wdHkgYW5kIG5vdGlmaWNhdGlvbiBoYXMgbm8gc3BlY2lhbGlzdEhpbnRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIGNvbnN0IGN0eCA9IGNyZWF0ZU1vY2tDdHgoKTtcbiAgICBjb25zdCBkaXNwYXRjaGVkOiBBcnJheTx7IGN1c3RvbVR5cGU6IHN0cmluZzsgY29udGVudDogc3RyaW5nOyBkaXNwbGF5OiBib29sZWFuIH0+ID0gW107XG4gICAgY29uc3QgbW9ja1BpID0ge1xuICAgICAgc2VuZE1lc3NhZ2UobXNnOiB7IGN1c3RvbVR5cGU6IHN0cmluZzsgY29udGVudDogc3RyaW5nOyBkaXNwbGF5OiBib29sZWFuIH0pIHtcbiAgICAgICAgZGlzcGF0Y2hlZC5wdXNoKG1zZyk7XG4gICAgICB9LFxuICAgIH07XG4gICAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmN3ZCgpO1xuICAgIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgICB0cnkge1xuICAgICAgY3JlYXRlRGVidWdTZXNzaW9uKGJhc2UsIHsgaXNzdWU6IFwiU2xvdyBxdWVyeVwiLCBjcmVhdGVkQXQ6IDEwIH0pO1xuICAgICAgdXBkYXRlRGVidWdTZXNzaW9uKGJhc2UsIFwic2xvdy1xdWVyeVwiLCB7XG4gICAgICAgIGNoZWNrcG9pbnQ6IHsgdHlwZTogXCJodW1hbi1hY3Rpb25cIiwgc3VtbWFyeTogXCJWZXJpZnkgaW5kZXggZXhpc3RzXCIsIGF3YWl0aW5nUmVzcG9uc2U6IHRydWUgfSxcbiAgICAgIH0pO1xuXG4gICAgICBhd2FpdCBoYW5kbGVEZWJ1ZyhcImNvbnRpbnVlIHNsb3ctcXVlcnlcIiwgY3R4IGFzIGFueSwgbW9ja1BpIGFzIGFueSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChkaXNwYXRjaGVkLmxlbmd0aCwgMSk7XG4gICAgICBjb25zdCBjb250ZW50ID0gZGlzcGF0Y2hlZFswXS5jb250ZW50O1xuICAgICAgLy8gTm8gc3BlY2lhbGlzdCBjb250ZW50XG4gICAgICBhc3NlcnQuZG9lc05vdE1hdGNoKGNvbnRlbnQsIC9QcmlvciBTcGVjaWFsaXN0IFJldmlldy8pO1xuICAgICAgYXNzZXJ0LmRvZXNOb3RNYXRjaChjdHgubm90aWZpY2F0aW9uc1swXS5tZXNzYWdlLCAvc3BlY2lhbGlzdEhpbnQvKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcHJvY2Vzcy5jaGRpcihzYXZlZCk7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImNvbnRpbnVlIHdpdGggY2hlY2twb2ludCArIHNwZWNpYWxpc3RSZXZpZXcgXHUyMDE0IGJvdGggY29udGV4dHMgYXBwZWFyIGluIGRpc3BhdGNoXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgICBjb25zdCBjdHggPSBjcmVhdGVNb2NrQ3R4KCk7XG4gICAgY29uc3QgZGlzcGF0Y2hlZDogQXJyYXk8eyBjdXN0b21UeXBlOiBzdHJpbmc7IGNvbnRlbnQ6IHN0cmluZzsgZGlzcGxheTogYm9vbGVhbiB9PiA9IFtdO1xuICAgIGNvbnN0IG1vY2tQaSA9IHtcbiAgICAgIHNlbmRNZXNzYWdlKG1zZzogeyBjdXN0b21UeXBlOiBzdHJpbmc7IGNvbnRlbnQ6IHN0cmluZzsgZGlzcGxheTogYm9vbGVhbiB9KSB7XG4gICAgICAgIGRpc3BhdGNoZWQucHVzaChtc2cpO1xuICAgICAgfSxcbiAgICB9O1xuICAgIGNvbnN0IHNhdmVkID0gcHJvY2Vzcy5jd2QoKTtcbiAgICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNyZWF0ZURlYnVnU2Vzc2lvbihiYXNlLCB7IGlzc3VlOiBcIk1lbW9yeSBsZWFrIGluIGNhY2hlXCIsIGNyZWF0ZWRBdDogMTAgfSk7XG4gICAgICB1cGRhdGVEZWJ1Z1Nlc3Npb24oYmFzZSwgXCJtZW1vcnktbGVhay1pbi1jYWNoZVwiLCB7XG4gICAgICAgIGNoZWNrcG9pbnQ6IHtcbiAgICAgICAgICB0eXBlOiBcImh1bWFuLXZlcmlmeVwiLFxuICAgICAgICAgIHN1bW1hcnk6IFwiVmVyaWZ5IGhlYXAgc25hcHNob3Qgc2hvd3MgbGVha1wiLFxuICAgICAgICAgIGF3YWl0aW5nUmVzcG9uc2U6IHRydWUsXG4gICAgICAgICAgdXNlclJlc3BvbnNlOiBcIlllcywgY29uZmlybWVkIGxlYWsgYXQgbGluZSA0MlwiLFxuICAgICAgICB9LFxuICAgICAgICBzcGVjaWFsaXN0UmV2aWV3OiB7XG4gICAgICAgICAgaGludDogXCJkYXRhYmFzZVwiLFxuICAgICAgICAgIHNraWxsOiBcInN1cGFiYXNlLXBvc3RncmVzLWJlc3QtcHJhY3RpY2VzXCIsXG4gICAgICAgICAgdmVyZGljdDogXCJMT09LU19HT09EXCIsXG4gICAgICAgICAgZGV0YWlsOiBcIlF1ZXJ5IHBsYW4gaXMgb3B0aW1hbFwiLFxuICAgICAgICAgIHJldmlld2VkQXQ6IDIwMDAsXG4gICAgICAgIH0sXG4gICAgICB9KTtcblxuICAgICAgYXdhaXQgaGFuZGxlRGVidWcoXCJjb250aW51ZSBtZW1vcnktbGVhay1pbi1jYWNoZVwiLCBjdHggYXMgYW55LCBtb2NrUGkgYXMgYW55KTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKGRpc3BhdGNoZWQubGVuZ3RoLCAxKTtcbiAgICAgIGNvbnN0IGNvbnRlbnQgPSBkaXNwYXRjaGVkWzBdLmNvbnRlbnQ7XG4gICAgICAvLyBDaGVja3BvaW50IGNvbnRleHQgcHJlc2VudFxuICAgICAgYXNzZXJ0Lm1hdGNoKGNvbnRlbnQsIC9BY3RpdmUgQ2hlY2twb2ludC8pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKGNvbnRlbnQsIC9WZXJpZnkgaGVhcCBzbmFwc2hvdC8pO1xuICAgICAgLy8gU3BlY2lhbGlzdCBjb250ZXh0IHByZXNlbnRcbiAgICAgIGFzc2VydC5tYXRjaChjb250ZW50LCAvUHJpb3IgU3BlY2lhbGlzdCBSZXZpZXcvKTtcbiAgICAgIGFzc2VydC5tYXRjaChjb250ZW50LCAvaGludDogZGF0YWJhc2UvKTtcbiAgICAgIGFzc2VydC5tYXRjaChjb250ZW50LCAvdmVyZGljdDogTE9PS1NfR09PRC8pO1xuICAgICAgLy8gTm90aWZpY2F0aW9uIGluY2x1ZGVzIGJvdGggY2hlY2twb2ludCB0eXBlIGFuZCBzcGVjaWFsaXN0IGhpbnRcbiAgICAgIGFzc2VydC5tYXRjaChjdHgubm90aWZpY2F0aW9uc1swXS5tZXNzYWdlLCAvY2hlY2twb2ludFR5cGU9aHVtYW4tdmVyaWZ5Lyk7XG4gICAgICBhc3NlcnQubWF0Y2goY3R4Lm5vdGlmaWNhdGlvbnNbMF0ubWVzc2FnZSwgL3NwZWNpYWxpc3RIaW50PWRhdGFiYXNlLyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHByb2Nlc3MuY2hkaXIoc2F2ZWQpO1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFFBQVEsZ0JBQWdCO0FBQy9CLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxRQUFRLHFCQUFxQjtBQUM5RCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBRXZCLFNBQVMsYUFBYSx5QkFBeUI7QUFDL0MsU0FBUyxvQkFBb0IsMEJBQTBCLDBCQUEwQjtBQUNqRixTQUFTLGtCQUFrQjtBQUUzQixTQUFTLFdBQW1CO0FBQzFCLFFBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLG9CQUFvQixDQUFDO0FBQzdELFlBQVUsS0FBSyxNQUFNLE1BQU0sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2pELFNBQU87QUFDVDtBQUVBLFNBQVMsZ0JBQWdCO0FBQ3ZCLFFBQU0sZ0JBQTJELENBQUM7QUFDbEUsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBLElBQUk7QUFBQSxNQUNGLE9BQU8sU0FBaUIsT0FBZTtBQUNyQyxzQkFBYyxLQUFLLEVBQUUsU0FBUyxNQUFNLENBQUM7QUFBQSxNQUN2QztBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0Y7QUFFQSxTQUFTLHFCQUFxQixNQUFNO0FBQ2xDLE9BQUssd0RBQXdELE1BQU07QUFDakUsV0FBTyxVQUFVLGtCQUFrQixNQUFNLEdBQUcsRUFBRSxNQUFNLE9BQU8sQ0FBQztBQUM1RCxXQUFPLFVBQVUsa0JBQWtCLG1CQUFtQixHQUFHLEVBQUUsTUFBTSxVQUFVLE1BQU0sYUFBYSxDQUFDO0FBQy9GLFdBQU8sVUFBVSxrQkFBa0IscUJBQXFCLEdBQUcsRUFBRSxNQUFNLFlBQVksTUFBTSxhQUFhLENBQUM7QUFDbkcsV0FBTyxVQUFVLGtCQUFrQixZQUFZLEdBQUcsRUFBRSxNQUFNLFdBQVcsQ0FBQztBQUFBLEVBQ3hFLENBQUM7QUFFRCxPQUFLLHFGQUFxRixNQUFNO0FBQzlGLFdBQU8sVUFBVSxrQkFBa0IsOEJBQThCLEdBQUc7QUFBQSxNQUNsRSxNQUFNO0FBQUEsTUFDTixPQUFPO0FBQUEsSUFDVCxDQUFDO0FBQ0QsV0FBTyxVQUFVLGtCQUFrQiw4QkFBOEIsR0FBRztBQUFBLE1BQ2xFLE1BQU07QUFBQSxNQUNOLE9BQU87QUFBQSxJQUNULENBQUM7QUFDRCxXQUFPLFVBQVUsa0JBQWtCLDRCQUE0QixHQUFHO0FBQUEsTUFDaEUsTUFBTTtBQUFBLE1BQ04sT0FBTztBQUFBLElBQ1QsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQUVELE9BQUssa0VBQWtFLE1BQU07QUFDM0UsV0FBTyxNQUFNLGtCQUFrQixRQUFRLEVBQUUsTUFBTSxPQUFPO0FBQ3RELFdBQU8sTUFBTSxrQkFBa0IsVUFBVSxFQUFFLE1BQU0sT0FBTztBQUN4RCxXQUFPLE1BQU0sa0JBQWtCLHVCQUF1QixFQUFFLE1BQU0sT0FBTztBQUNyRSxXQUFPLE1BQU0sa0JBQWtCLE9BQU8sRUFBRSxNQUFNLE9BQU87QUFBQSxFQUN2RCxDQUFDO0FBRUQsT0FBSywrRUFBK0UsTUFBTTtBQUN4RixXQUFPLFVBQVUsa0JBQWtCLGtDQUFrQyxHQUFHO0FBQUEsTUFDdEUsTUFBTTtBQUFBLE1BQ04sT0FBTztBQUFBLElBQ1QsQ0FBQztBQUNELFdBQU8sVUFBVSxrQkFBa0IsZ0NBQWdDLEdBQUc7QUFBQSxNQUNwRSxNQUFNO0FBQUEsTUFDTixPQUFPO0FBQUEsSUFDVCxDQUFDO0FBQ0QsV0FBTyxVQUFVLGtCQUFrQixvQ0FBb0MsR0FBRztBQUFBLE1BQ3hFLE1BQU07QUFBQSxNQUNOLE9BQU87QUFBQSxJQUNULENBQUM7QUFBQSxFQUNILENBQUM7QUFFRCxPQUFLLDZEQUE2RCxNQUFNO0FBQ3RFLFdBQU8sVUFBVSxrQkFBa0IsdUJBQXVCLEdBQUc7QUFBQSxNQUMzRCxNQUFNO0FBQUEsTUFDTixNQUFNO0FBQUEsSUFDUixDQUFDO0FBQ0QsV0FBTyxVQUFVLGtCQUFrQix1QkFBdUIsR0FBRztBQUFBLE1BQzNELE1BQU07QUFBQSxNQUNOLE1BQU07QUFBQSxJQUNSLENBQUM7QUFBQSxFQUNILENBQUM7QUFFRCxPQUFLLHlEQUF5RCxNQUFNO0FBQ2xFLFdBQU8sVUFBVSxrQkFBa0IsWUFBWSxHQUFHLEVBQUUsTUFBTSxXQUFXLENBQUM7QUFBQSxFQUN4RSxDQUFDO0FBRUQsT0FBSywwRUFBMEUsTUFBTTtBQUNuRixXQUFPLE1BQU0sa0JBQWtCLHVCQUF1QixFQUFFLE1BQU0sT0FBTztBQUNyRSxXQUFPLE1BQU0sa0JBQWtCLHNCQUFzQixFQUFFLE1BQU0sT0FBTztBQUNwRSxXQUFPLE1BQU0sa0JBQWtCLHNCQUFzQixFQUFFLE1BQU0sZ0JBQWdCO0FBQUEsRUFDL0UsQ0FBQztBQUVELE9BQUssd0VBQXdFLE1BQU07QUFDakYsV0FBTyxVQUFVLGtCQUFrQiw0QkFBNEIsR0FBRztBQUFBLE1BQ2hFLE1BQU07QUFBQSxNQUNOLE9BQU87QUFBQSxJQUNULENBQUM7QUFDRCxXQUFPLFVBQVUsa0JBQWtCLHVCQUF1QixHQUFHO0FBQUEsTUFDM0QsTUFBTTtBQUFBLE1BQ04sT0FBTztBQUFBLElBQ1QsQ0FBQztBQUNELFdBQU8sVUFBVSxrQkFBa0IsOEJBQThCLEdBQUc7QUFBQSxNQUNsRSxNQUFNO0FBQUEsTUFDTixPQUFPO0FBQUEsSUFDVCxDQUFDO0FBQUEsRUFDSCxDQUFDO0FBQ0gsQ0FBQztBQUVELFNBQVMseUJBQXlCLE1BQU07QUFDdEMsT0FBSyx3REFBd0QsWUFBWTtBQUN2RSxVQUFNLE9BQU8sU0FBUztBQUN0QixVQUFNLE1BQU0sY0FBYztBQUMxQixVQUFNLFFBQVEsUUFBUSxJQUFJO0FBQzFCLFlBQVEsTUFBTSxJQUFJO0FBRWxCLFFBQUk7QUFDRixZQUFNLFlBQVkseUJBQXlCLEdBQVU7QUFDckQsYUFBTyxNQUFNLElBQUksY0FBYyxRQUFRLENBQUM7QUFDeEMsWUFBTSxPQUFPLElBQUksY0FBYyxDQUFDO0FBQ2hDLGFBQU8sTUFBTSxLQUFLLE9BQU8sTUFBTTtBQUMvQixhQUFPLE1BQU0sS0FBSyxTQUFTLDhDQUE4QztBQUN6RSxhQUFPLE1BQU0sS0FBSyxTQUFTLFlBQVk7QUFDdkMsYUFBTyxNQUFNLEtBQUssU0FBUyxjQUFjO0FBRXpDLFlBQU0sV0FBVyx5QkFBeUIsTUFBTSx1QkFBdUI7QUFDdkUsWUFBTSxZQUFZLGNBQWM7QUFDaEMsWUFBTSxZQUFZLGdDQUFnQyxTQUFnQjtBQUNsRSxhQUFPLE1BQU0sVUFBVSxjQUFjLENBQUMsRUFBRSxTQUFTLElBQUksT0FBTyxTQUFTLFFBQVEsdUJBQXVCLE1BQU0sQ0FBQyxDQUFDO0FBQzVHLGFBQU8sTUFBTSxVQUFVLGNBQWMsQ0FBQyxFQUFFLFNBQVMsZUFBZTtBQUNoRSxhQUFPLE1BQU0sVUFBVSxjQUFjLENBQUMsRUFBRSxTQUFTLGNBQWM7QUFBQSxJQUNqRSxVQUFFO0FBQ0EsY0FBUSxNQUFNLEtBQUs7QUFDbkIsYUFBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDL0M7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLGlGQUFpRixZQUFZO0FBQ2hHLFVBQU0sT0FBTyxTQUFTO0FBQ3RCLFVBQU0sTUFBTSxjQUFjO0FBQzFCLFVBQU0sYUFHRCxDQUFDO0FBQ04sVUFBTSxTQUFTO0FBQUEsTUFDYixZQUNFLEtBQ0EsU0FDQTtBQUNBLG1CQUFXLEtBQUssRUFBRSxLQUFLLFFBQVEsQ0FBQztBQUFBLE1BQ2xDO0FBQUEsSUFDRjtBQUNBLFVBQU0sUUFBUSxRQUFRLElBQUk7QUFDMUIsWUFBUSxNQUFNLElBQUk7QUFFbEIsUUFBSTtBQUNGLFlBQU0sWUFBWSx5QkFBeUIsS0FBWSxNQUFhO0FBRXBFLGFBQU8sTUFBTSxJQUFJLGNBQWMsQ0FBQyxFQUFFLE9BQU8sTUFBTTtBQUMvQyxhQUFPLE1BQU0sSUFBSSxjQUFjLENBQUMsRUFBRSxTQUFTLDhDQUE4QztBQUN6RixhQUFPLE1BQU0sSUFBSSxjQUFjLENBQUMsRUFBRSxTQUFTLDJCQUEyQjtBQUN0RSxhQUFPLE1BQU0sV0FBVyxRQUFRLENBQUM7QUFDakMsYUFBTyxNQUFNLFdBQVcsQ0FBQyxFQUFFLElBQUksWUFBWSxpQkFBaUI7QUFDNUQsYUFBTyxNQUFNLFdBQVcsQ0FBQyxFQUFFLElBQUksU0FBUyxLQUFLO0FBQzdDLGFBQU8sTUFBTSxXQUFXLENBQUMsRUFBRSxRQUFRLGFBQWEsSUFBSTtBQUNwRCxhQUFPLE1BQU0sV0FBVyxDQUFDLEVBQUUsSUFBSSxTQUFTLGdCQUFnQjtBQUN4RCxhQUFPLE1BQU0sV0FBVyxDQUFDLEVBQUUsSUFBSSxTQUFTLHVCQUF1QjtBQUMvRCxhQUFPLE1BQU0sV0FBVyxDQUFDLEVBQUUsSUFBSSxTQUFTLHVCQUF1QjtBQUFBLElBQ2pFLFVBQUU7QUFDQSxjQUFRLE1BQU0sS0FBSztBQUNuQixhQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUMvQztBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssa0VBQWtFLFlBQVk7QUFDakYsVUFBTSxPQUFPLFNBQVM7QUFDdEIsVUFBTSxNQUFNLGNBQWM7QUFDMUIsVUFBTSxRQUFRLFFBQVEsSUFBSTtBQUMxQixZQUFRLE1BQU0sSUFBSTtBQUVsQixRQUFJO0FBQ0YseUJBQW1CLE1BQU0sRUFBRSxPQUFPLGdCQUFnQixXQUFXLEdBQUcsQ0FBQztBQUNqRSx5QkFBbUIsTUFBTSxFQUFFLE9BQU8sbUJBQW1CLFdBQVcsR0FBRyxDQUFDO0FBRXBFLFlBQU0sWUFBWSxRQUFRLEdBQVU7QUFDcEMsYUFBTyxNQUFNLElBQUksY0FBYyxRQUFRLENBQUM7QUFDeEMsWUFBTSxPQUFPLElBQUksY0FBYyxDQUFDLEVBQUU7QUFDbEMsYUFBTyxNQUFNLE1BQU0saUJBQWlCO0FBQ3BDLGFBQU8sTUFBTSxNQUFNLHVDQUF1QztBQUMxRCxhQUFPLE1BQU0sTUFBTSxjQUFjO0FBQ2pDLGFBQU8sTUFBTSxNQUFNLGlCQUFpQjtBQUFBLElBQ3RDLFVBQUU7QUFDQSxjQUFRLE1BQU0sS0FBSztBQUNuQixhQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUMvQztBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssNENBQTRDLFlBQVk7QUFDM0QsVUFBTSxPQUFPLFNBQVM7QUFDdEIsVUFBTSxNQUFNLGNBQWM7QUFDMUIsVUFBTSxRQUFRLFFBQVEsSUFBSTtBQUMxQixZQUFRLE1BQU0sSUFBSTtBQUVsQixRQUFJO0FBQ0YseUJBQW1CLE1BQU0sRUFBRSxPQUFPLFlBQVksV0FBVyxJQUFJLFFBQVEsVUFBVSxPQUFPLFVBQVUsQ0FBQztBQUVqRyxZQUFNLFlBQVkscUJBQXFCLEdBQVU7QUFDakQsYUFBTyxNQUFNLElBQUksY0FBYyxRQUFRLENBQUM7QUFDeEMsWUFBTSxPQUFPLElBQUksY0FBYyxDQUFDLEVBQUU7QUFDbEMsYUFBTyxNQUFNLE1BQU0saUNBQWlDO0FBQ3BELGFBQU8sTUFBTSxNQUFNLGVBQWU7QUFDbEMsYUFBTyxNQUFNLE1BQU0saUJBQWlCO0FBRXBDLFlBQU0sWUFBWSxjQUFjO0FBQ2hDLFlBQU0sWUFBWSxtQkFBbUIsU0FBZ0I7QUFDckQsYUFBTyxNQUFNLFVBQVUsY0FBYyxDQUFDLEVBQUUsU0FBUyxlQUFlO0FBQ2hFLGFBQU8sTUFBTSxVQUFVLGNBQWMsQ0FBQyxFQUFFLFNBQVMsaUJBQWlCO0FBQUEsSUFDcEUsVUFBRTtBQUNBLGNBQVEsTUFBTSxLQUFLO0FBQ25CLGFBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQy9DO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyxtRUFBbUUsWUFBWTtBQUNsRixVQUFNLE9BQU8sU0FBUztBQUN0QixVQUFNLFFBQVEsUUFBUSxJQUFJO0FBQzFCLFlBQVEsTUFBTSxJQUFJO0FBRWxCLFFBQUk7QUFDRixZQUFNLGlCQUFpQixjQUFjO0FBQ3JDLFlBQU0sWUFBWSxVQUFVLGNBQXFCO0FBQ2pELGFBQU8sTUFBTSxlQUFlLGNBQWMsQ0FBQyxFQUFFLE9BQU8sU0FBUztBQUM3RCxhQUFPLE1BQU0sZUFBZSxjQUFjLENBQUMsRUFBRSxTQUFTLGNBQWM7QUFFcEUsWUFBTSxpQkFBaUIsY0FBYztBQUNyQyxZQUFNLFlBQVksMEJBQTBCLGNBQXFCO0FBQ2pFLGFBQU8sTUFBTSxlQUFlLGNBQWMsQ0FBQyxFQUFFLE9BQU8sU0FBUztBQUM3RCxhQUFPLE1BQU0sZUFBZSxjQUFjLENBQUMsRUFBRSxTQUFTLDRCQUE0QjtBQUNsRixhQUFPLE1BQU0sZUFBZSxjQUFjLENBQUMsRUFBRSxTQUFTLGtCQUFrQjtBQUFBLElBQzFFLFVBQUU7QUFDQSxjQUFRLE1BQU0sS0FBSztBQUNuQixhQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUMvQztBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUsseUVBQXlFLFlBQVk7QUFDeEYsVUFBTSxPQUFPLFNBQVM7QUFDdEIsVUFBTSxRQUFRLFFBQVEsSUFBSTtBQUMxQixZQUFRLE1BQU0sSUFBSTtBQUVsQixRQUFJO0FBQ0YseUJBQW1CLE1BQU0sRUFBRSxPQUFPLGlCQUFpQixXQUFXLEVBQUUsQ0FBQztBQUNqRSxvQkFBYyxLQUFLLE1BQU0sUUFBUSxTQUFTLFlBQVksYUFBYSxHQUFHLFVBQVUsT0FBTztBQUV2RixZQUFNLFVBQVUsY0FBYztBQUM5QixZQUFNLFlBQVksUUFBUSxPQUFjO0FBQ3hDLGFBQU8sTUFBTSxRQUFRLGNBQWMsQ0FBQyxFQUFFLFNBQVMsd0JBQXdCO0FBQ3ZFLGFBQU8sTUFBTSxRQUFRLGNBQWMsQ0FBQyxFQUFFLFNBQVMsNEJBQTRCO0FBRTNFLFlBQU0sY0FBYyxjQUFjO0FBQ2xDLFlBQU0sWUFBWSxjQUFjLFdBQWtCO0FBQ2xELGFBQU8sTUFBTSxZQUFZLGNBQWMsQ0FBQyxFQUFFLE9BQU8sU0FBUztBQUMxRCxhQUFPLE1BQU0sWUFBWSxjQUFjLENBQUMsRUFBRSxTQUFTLHFCQUFxQjtBQUN4RSxhQUFPLE1BQU0sWUFBWSxjQUFjLENBQUMsRUFBRSxTQUFTLGNBQWM7QUFBQSxJQUNuRSxVQUFFO0FBQ0EsY0FBUSxNQUFNLEtBQUs7QUFDbkIsYUFBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDL0M7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLG9GQUFvRixZQUFZO0FBQ25HLFVBQU0sT0FBTyxTQUFTO0FBQ3RCLFVBQU0sUUFBUSxRQUFRLElBQUk7QUFDMUIsWUFBUSxNQUFNLElBQUk7QUFFbEIsUUFBSTtBQUNGLFlBQU0sTUFBTSxjQUFjO0FBQzFCLFlBQU0sWUFBWSxpQ0FBaUMsR0FBVTtBQUM3RCxhQUFPLE1BQU0sSUFBSSxjQUFjLENBQUMsRUFBRSxPQUFPLE1BQU07QUFDL0MsYUFBTyxNQUFNLElBQUksY0FBYyxDQUFDLEVBQUUsU0FBUyx3QkFBd0I7QUFFbkUsWUFBTSxPQUFPO0FBQ2IsWUFBTSxZQUFZLGNBQWM7QUFDaEMsWUFBTSxZQUFZLFVBQVUsSUFBSSxJQUFJLFNBQWdCO0FBQ3BELGFBQU8sTUFBTSxVQUFVLGNBQWMsQ0FBQyxFQUFFLE9BQU8sTUFBTTtBQUNyRCxhQUFPLE1BQU0sVUFBVSxjQUFjLENBQUMsRUFBRSxTQUFTLFlBQVk7QUFBQSxJQUMvRCxVQUFFO0FBQ0EsY0FBUSxNQUFNLEtBQUs7QUFDbkIsYUFBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDL0M7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLHlHQUF5RyxZQUFZO0FBQ3hILFVBQU0sT0FBTyxTQUFTO0FBQ3RCLFVBQU0sTUFBTSxjQUFjO0FBQzFCLFVBQU0sUUFBUSxRQUFRLElBQUk7QUFDMUIsWUFBUSxNQUFNLElBQUk7QUFFbEIsUUFBSTtBQUNGLFlBQU0sWUFBWSxvQ0FBb0MsR0FBVTtBQUNoRSxhQUFPLE1BQU0sSUFBSSxjQUFjLFFBQVEsQ0FBQztBQUN4QyxZQUFNLE9BQU8sSUFBSSxjQUFjLENBQUM7QUFDaEMsYUFBTyxNQUFNLEtBQUssT0FBTyxNQUFNO0FBQy9CLGFBQU8sTUFBTSxLQUFLLFNBQVMsaURBQWlEO0FBQzVFLGFBQU8sTUFBTSxLQUFLLFNBQVMsZUFBZTtBQUMxQyxhQUFPLE1BQU0sS0FBSyxTQUFTLG1DQUFtQztBQUM5RCxhQUFPLE1BQU0sS0FBSyxTQUFTLGNBQWM7QUFDekMsYUFBTyxNQUFNLEtBQUssU0FBUyxlQUFlO0FBRTFDLFlBQU0sWUFBWSxjQUFjO0FBQ2hDLFlBQU0sWUFBWSxnQ0FBZ0MsU0FBZ0I7QUFDbEUsYUFBTyxNQUFNLFVBQVUsY0FBYyxDQUFDLEVBQUUsU0FBUyxlQUFlO0FBQ2hFLGFBQU8sTUFBTSxVQUFVLGNBQWMsQ0FBQyxFQUFFLFNBQVMsZUFBZTtBQUFBLElBQ2xFLFVBQUU7QUFDQSxjQUFRLE1BQU0sS0FBSztBQUNuQixhQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUMvQztBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssb0VBQW9FLFlBQVk7QUFDbkYsVUFBTSxPQUFPLFNBQVM7QUFDdEIsVUFBTSxRQUFRLFFBQVEsSUFBSTtBQUMxQixZQUFRLE1BQU0sSUFBSTtBQUVsQixRQUFJO0FBQ0YseUJBQW1CLE1BQU0sRUFBRSxPQUFPLG9CQUFvQixXQUFXLEVBQUUsQ0FBQztBQUVwRSxZQUFNLE1BQU0sY0FBYztBQUMxQixZQUFNLFlBQVksK0JBQStCLEdBQVU7QUFDM0QsYUFBTyxNQUFNLElBQUksY0FBYyxRQUFRLENBQUM7QUFDeEMsYUFBTyxNQUFNLElBQUksY0FBYyxDQUFDLEVBQUUsT0FBTyxNQUFNO0FBQy9DLGFBQU8sTUFBTSxJQUFJLGNBQWMsQ0FBQyxFQUFFLFNBQVMsb0NBQW9DO0FBQy9FLGFBQU8sTUFBTSxJQUFJLGNBQWMsQ0FBQyxFQUFFLFNBQVMsZUFBZTtBQUMxRCxhQUFPLE1BQU0sSUFBSSxjQUFjLENBQUMsRUFBRSxTQUFTLDZCQUE2QjtBQUFBLElBQzFFLFVBQUU7QUFDQSxjQUFRLE1BQU0sS0FBSztBQUNuQixhQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUMvQztBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUsseURBQXlELFlBQVk7QUFDeEUsVUFBTSxPQUFPLFNBQVM7QUFDdEIsVUFBTSxRQUFRLFFBQVEsSUFBSTtBQUMxQixZQUFRLE1BQU0sSUFBSTtBQUVsQixRQUFJO0FBQ0YsWUFBTSxNQUFNLGNBQWM7QUFDMUIsWUFBTSxZQUFZLDhCQUE4QixHQUFVO0FBQzFELGFBQU8sTUFBTSxJQUFJLGNBQWMsQ0FBQyxFQUFFLE9BQU8sU0FBUztBQUNsRCxhQUFPLE1BQU0sSUFBSSxjQUFjLENBQUMsRUFBRSxTQUFTLFdBQVc7QUFDdEQsYUFBTyxNQUFNLElBQUksY0FBYyxDQUFDLEVBQUUsU0FBUyxrQkFBa0I7QUFBQSxJQUMvRCxVQUFFO0FBQ0EsY0FBUSxNQUFNLEtBQUs7QUFDbkIsYUFBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDL0M7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLGtGQUFrRixZQUFZO0FBQ2pHLFVBQU0sT0FBTyxTQUFTO0FBQ3RCLFVBQU0sUUFBUSxRQUFRLElBQUk7QUFDMUIsWUFBUSxNQUFNLElBQUk7QUFFbEIsUUFBSTtBQUNGLHlCQUFtQixNQUFNLEVBQUUsT0FBTyxpQkFBaUIsV0FBVyxFQUFFLENBQUM7QUFDakUsb0JBQWMsS0FBSyxNQUFNLFFBQVEsU0FBUyxZQUFZLGFBQWEsR0FBRyxVQUFVLE9BQU87QUFFdkYsWUFBTSxNQUFNLGNBQWM7QUFDMUIsWUFBTSxZQUFZLGlEQUFpRCxHQUFVO0FBQzdFLGFBQU8sTUFBTSxJQUFJLGNBQWMsQ0FBQyxFQUFFLE9BQU8sTUFBTTtBQUMvQyxhQUFPLE1BQU0sSUFBSSxjQUFjLENBQUMsRUFBRSxTQUFTLDJCQUEyQjtBQUN0RSxhQUFPLE1BQU0sSUFBSSxjQUFjLENBQUMsRUFBRSxTQUFTLGVBQWU7QUFBQSxJQUM1RCxVQUFFO0FBQ0EsY0FBUSxNQUFNLEtBQUs7QUFDbkIsYUFBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDL0M7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLCtEQUErRCxZQUFZO0FBQzlFLFVBQU0sT0FBTyxTQUFTO0FBQ3RCLFVBQU0sUUFBUSxRQUFRLElBQUk7QUFDMUIsWUFBUSxNQUFNLElBQUk7QUFFbEIsUUFBSTtBQUNGLHlCQUFtQixNQUFNLEVBQUUsT0FBTyxjQUFjLFdBQVcsR0FBRyxRQUFRLFlBQVksT0FBTyxXQUFXLENBQUM7QUFFckcsWUFBTSxNQUFNLGNBQWM7QUFDMUIsWUFBTSxZQUFZLHVCQUF1QixHQUFVO0FBQ25ELGFBQU8sTUFBTSxJQUFJLGNBQWMsQ0FBQyxFQUFFLE9BQU8sU0FBUztBQUNsRCxhQUFPLE1BQU0sSUFBSSxjQUFjLENBQUMsRUFBRSxTQUFTLFVBQVU7QUFBQSxJQUN2RCxVQUFFO0FBQ0EsY0FBUSxNQUFNLEtBQUs7QUFDbkIsYUFBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDL0M7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLHFFQUFxRSxZQUFZO0FBQ3BGLFVBQU0sT0FBTyxTQUFTO0FBQ3RCLFVBQU0sUUFBUSxRQUFRLElBQUk7QUFDMUIsWUFBUSxNQUFNLElBQUk7QUFFbEIsUUFBSTtBQUNGLFlBQU0sTUFBTSxjQUFjO0FBQzFCLFlBQU0sWUFBWSw0QkFBNEIsR0FBVTtBQUN4RCxhQUFPLE1BQU0sSUFBSSxjQUFjLENBQUMsRUFBRSxPQUFPLFNBQVM7QUFDbEQsYUFBTyxNQUFNLElBQUksY0FBYyxDQUFDLEVBQUUsU0FBUyxvQkFBb0I7QUFBQSxJQUNqRSxVQUFFO0FBQ0EsY0FBUSxNQUFNLEtBQUs7QUFDbkIsYUFBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDL0M7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLHNGQUFzRixZQUFZO0FBQ3JHLFVBQU0sT0FBTyxTQUFTO0FBQ3RCLFVBQU0sTUFBTSxjQUFjO0FBQzFCLFVBQU0sYUFBK0UsQ0FBQztBQUN0RixVQUFNLFNBQVM7QUFBQSxNQUNiLFlBQVksS0FBZ0U7QUFDMUUsbUJBQVcsS0FBSyxHQUFHO0FBQUEsTUFDckI7QUFBQSxJQUNGO0FBQ0EsVUFBTSxRQUFRLFFBQVEsSUFBSTtBQUMxQixZQUFRLE1BQU0sSUFBSTtBQUVsQixRQUFJO0FBQ0YsWUFBTSxZQUFZLHlDQUF5QyxLQUFZLE1BQWE7QUFFcEYsYUFBTyxNQUFNLElBQUksY0FBYyxDQUFDLEVBQUUsT0FBTyxNQUFNO0FBQy9DLGFBQU8sTUFBTSxJQUFJLGNBQWMsQ0FBQyxFQUFFLFNBQVMsbUNBQW1DO0FBRzlFLGFBQU8sTUFBTSxXQUFXLFFBQVEsQ0FBQztBQUNqQyxZQUFNLFdBQVcsV0FBVyxDQUFDO0FBQzdCLGFBQU8sTUFBTSxTQUFTLFlBQVksb0JBQW9CO0FBQ3RELGFBQU8sTUFBTSxTQUFTLFNBQVMsS0FBSztBQUVwQyxhQUFPLE1BQU0sU0FBUyxTQUFTLHdCQUF3QjtBQUV2RCxhQUFPLE1BQU0sU0FBUyxTQUFTLG1DQUFtQztBQUNsRSxhQUFPLE1BQU0sU0FBUyxTQUFTLDRCQUE0QjtBQUMzRCxhQUFPLE1BQU0sU0FBUyxTQUFTLDRCQUE0QjtBQUFBLElBQzdELFVBQUU7QUFDQSxjQUFRLE1BQU0sS0FBSztBQUNuQixhQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUMvQztBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssdUVBQXVFLFlBQVk7QUFDdEYsVUFBTSxPQUFPLFNBQVM7QUFDdEIsVUFBTSxhQUF5QyxDQUFDO0FBQ2hELFVBQU0sU0FBUztBQUFBLE1BQ2IsWUFBWSxLQUFnRTtBQUMxRSxtQkFBVyxLQUFLLEdBQUc7QUFBQSxNQUNyQjtBQUFBLElBQ0Y7QUFDQSxVQUFNLFFBQVEsUUFBUSxJQUFJO0FBQzFCLFlBQVEsTUFBTSxJQUFJO0FBRWxCLFFBQUk7QUFDRixZQUFNLFlBQVksZ0RBQWdELGNBQWMsR0FBVSxNQUFhO0FBQ3ZHLGFBQU8sTUFBTSxXQUFXLFFBQVEsQ0FBQztBQUVqQyxhQUFPLE1BQU0sV0FBVyxDQUFDLEVBQUUsU0FBUyx3QkFBd0I7QUFDNUQsYUFBTyxNQUFNLFdBQVcsQ0FBQyxFQUFFLFNBQVMsbUNBQW1DO0FBQUEsSUFDekUsVUFBRTtBQUNBLGNBQVEsTUFBTSxLQUFLO0FBQ25CLGFBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQy9DO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyx3RUFBd0UsWUFBWTtBQUN2RixVQUFNLE9BQU8sU0FBUztBQUN0QixVQUFNLE1BQU0sY0FBYztBQUMxQixVQUFNLGFBQStFLENBQUM7QUFDdEYsVUFBTSxTQUFTO0FBQUEsTUFDYixZQUFZLEtBQWdFO0FBQzFFLG1CQUFXLEtBQUssR0FBRztBQUFBLE1BQ3JCO0FBQUEsSUFDRjtBQUNBLFVBQU0sUUFBUSxRQUFRLElBQUk7QUFDMUIsWUFBUSxNQUFNLElBQUk7QUFFbEIsUUFBSTtBQUNGLHlCQUFtQixNQUFNLEVBQUUsT0FBTyxnQkFBZ0IsV0FBVyxJQUFJLFFBQVEsVUFBVSxPQUFPLFVBQVUsQ0FBQztBQUNyRyx5QkFBbUIsTUFBTSxFQUFFLE9BQU8sbUJBQW1CLFdBQVcsSUFBSSxRQUFRLFVBQVUsT0FBTyxVQUFVLENBQUM7QUFFeEcsWUFBTSxZQUFZLHlCQUF5QixLQUFZLE1BQWE7QUFFcEUsYUFBTyxNQUFNLElBQUksY0FBYyxDQUFDLEVBQUUsU0FBUywyQkFBMkI7QUFHdEUsYUFBTyxNQUFNLFdBQVcsUUFBUSxDQUFDO0FBQ2pDLFlBQU0sV0FBVyxXQUFXLENBQUM7QUFDN0IsYUFBTyxNQUFNLFNBQVMsWUFBWSxvQkFBb0I7QUFDdEQsYUFBTyxNQUFNLFNBQVMsU0FBUyxLQUFLO0FBRXBDLGFBQU8sTUFBTSxTQUFTLFNBQVMsZ0JBQWdCO0FBRS9DLGFBQU8sTUFBTSxTQUFTLFNBQVMsY0FBYztBQUU3QyxhQUFPLGFBQWEsU0FBUyxTQUFTLGlCQUFpQjtBQUFBLElBQ3pELFVBQUU7QUFDQSxjQUFRLE1BQU0sS0FBSztBQUNuQixhQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUMvQztBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssK0VBQStFLFlBQVk7QUFDOUYsVUFBTSxPQUFPLFNBQVM7QUFDdEIsVUFBTSxNQUFNLGNBQWM7QUFDMUIsVUFBTSxTQUFTO0FBQUEsTUFDYixjQUFjO0FBQ1osY0FBTSxJQUFJLE1BQU0sdUJBQXVCO0FBQUEsTUFDekM7QUFBQSxJQUNGO0FBQ0EsVUFBTSxRQUFRLFFBQVEsSUFBSTtBQUMxQixZQUFRLE1BQU0sSUFBSTtBQUVsQixRQUFJO0FBQ0YseUJBQW1CLE1BQU0sRUFBRSxPQUFPLFlBQVksV0FBVyxJQUFJLFFBQVEsVUFBVSxPQUFPLFVBQVUsQ0FBQztBQUVqRyxZQUFNLFlBQVkscUJBQXFCLEtBQVksTUFBYTtBQUVoRSxhQUFPLE1BQU0sSUFBSSxjQUFjLENBQUMsRUFBRSxTQUFTLHVCQUF1QjtBQUdsRSxhQUFPLE1BQU0sSUFBSSxjQUFjLFFBQVEsQ0FBQztBQUN4QyxhQUFPLE1BQU0sSUFBSSxjQUFjLENBQUMsRUFBRSxPQUFPLFNBQVM7QUFDbEQsYUFBTyxNQUFNLElBQUksY0FBYyxDQUFDLEVBQUUsU0FBUywwQkFBMEI7QUFDckUsYUFBTyxNQUFNLElBQUksY0FBYyxDQUFDLEVBQUUsU0FBUyxVQUFVO0FBR3JELFlBQU0sWUFBWSxjQUFjO0FBQ2hDLFlBQU0sWUFBWSxtQkFBbUIsU0FBZ0I7QUFDckQsYUFBTyxNQUFNLFVBQVUsY0FBYyxDQUFDLEVBQUUsU0FBUyxlQUFlO0FBQ2hFLGFBQU8sTUFBTSxVQUFVLGNBQWMsQ0FBQyxFQUFFLFNBQVMsaUJBQWlCO0FBQUEsSUFDcEUsVUFBRTtBQUNBLGNBQVEsTUFBTSxLQUFLO0FBQ25CLGFBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQy9DO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSywyRUFBMkUsWUFBWTtBQUMxRixVQUFNLE9BQU8sU0FBUztBQUN0QixVQUFNLE1BQU0sY0FBYztBQUMxQixVQUFNLFNBQVM7QUFBQSxNQUNiLGNBQWM7QUFDWixjQUFNLElBQUksTUFBTSxnQkFBZ0I7QUFBQSxNQUNsQztBQUFBLElBQ0Y7QUFDQSxVQUFNLFFBQVEsUUFBUSxJQUFJO0FBQzFCLFlBQVEsTUFBTSxJQUFJO0FBRWxCLFFBQUk7QUFDRixZQUFNLFlBQVksK0NBQStDLEtBQVksTUFBYTtBQUUxRixhQUFPLE1BQU0sSUFBSSxjQUFjLENBQUMsRUFBRSxPQUFPLE1BQU07QUFDL0MsYUFBTyxNQUFNLElBQUksY0FBYyxDQUFDLEVBQUUsU0FBUywwQkFBMEI7QUFHckUsYUFBTyxNQUFNLElBQUksY0FBYyxRQUFRLENBQUM7QUFDeEMsYUFBTyxNQUFNLElBQUksY0FBYyxDQUFDLEVBQUUsT0FBTyxTQUFTO0FBQ2xELGFBQU8sTUFBTSxJQUFJLGNBQWMsQ0FBQyxFQUFFLFNBQVMsMEJBQTBCO0FBQ3JFLGFBQU8sTUFBTSxJQUFJLGNBQWMsQ0FBQyxFQUFFLFNBQVMsa0NBQWtDO0FBRzdFLFlBQU0sWUFBWSxjQUFjO0FBQ2hDLFlBQU0sWUFBWSwyQ0FBMkMsU0FBZ0I7QUFDN0UsYUFBTyxNQUFNLFVBQVUsY0FBYyxDQUFDLEVBQUUsT0FBTyxNQUFNO0FBQ3JELGFBQU8sTUFBTSxVQUFVLGNBQWMsQ0FBQyxFQUFFLFNBQVMsZUFBZTtBQUFBLElBQ2xFLFVBQUU7QUFDQSxjQUFRLE1BQU0sS0FBSztBQUNuQixhQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUMvQztBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssZ0VBQWdFLFlBQVk7QUFDL0UsVUFBTSxPQUFPLFNBQVM7QUFDdEIsVUFBTSxNQUFNLGNBQWM7QUFDMUIsVUFBTSxhQUE2QixDQUFDO0FBQ3BDLFVBQU0sU0FBUztBQUFBLE1BQ2IsWUFBWSxLQUFjO0FBQUUsbUJBQVcsS0FBSyxHQUFHO0FBQUEsTUFBRztBQUFBLElBQ3BEO0FBQ0EsVUFBTSxRQUFRLFFBQVEsSUFBSTtBQUMxQixZQUFRLE1BQU0sSUFBSTtBQUVsQixRQUFJO0FBQ0YsWUFBTSxZQUFZLHlCQUF5QixLQUFZLE1BQWE7QUFDcEUsYUFBTyxNQUFNLElBQUksY0FBYyxDQUFDLEVBQUUsT0FBTyxTQUFTO0FBQ2xELGFBQU8sTUFBTSxJQUFJLGNBQWMsQ0FBQyxFQUFFLFNBQVMsNEJBQTRCO0FBQ3ZFLGFBQU8sTUFBTSxXQUFXLFFBQVEsQ0FBQztBQUFBLElBQ25DLFVBQUU7QUFDQSxjQUFRLE1BQU0sS0FBSztBQUNuQixhQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUMvQztBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUsseUZBQXlGLFlBQVk7QUFDeEcsVUFBTSxPQUFPLFNBQVM7QUFDdEIsVUFBTSxhQUF5QyxDQUFDO0FBQ2hELFVBQU0sU0FBUztBQUFBLE1BQ2IsWUFBWSxLQUFnRTtBQUMxRSxtQkFBVyxLQUFLLEdBQUc7QUFBQSxNQUNyQjtBQUFBLElBQ0Y7QUFDQSxVQUFNLFFBQVEsUUFBUSxJQUFJO0FBQzFCLFlBQVEsTUFBTSxJQUFJO0FBRWxCLFFBQUk7QUFFRixZQUFNLFlBQVksc0RBQXNELGNBQWMsR0FBVSxNQUFhO0FBQzdHLGFBQU8sTUFBTSxXQUFXLFFBQVEsQ0FBQztBQUNqQyxhQUFPLE1BQU0sV0FBVyxDQUFDLEVBQUUsU0FBUyxzQkFBc0I7QUFDMUQsYUFBTyxNQUFNLFdBQVcsQ0FBQyxFQUFFLFNBQVMseUNBQXlDO0FBQUEsSUFDL0UsVUFBRTtBQUNBLGNBQVEsTUFBTSxLQUFLO0FBQ25CLGFBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQy9DO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyxvR0FBb0csWUFBWTtBQUNuSCxVQUFNLE9BQU8sU0FBUztBQUN0QixVQUFNLE1BQU0sY0FBYztBQUMxQixVQUFNLGFBQStFLENBQUM7QUFDdEYsVUFBTSxTQUFTO0FBQUEsTUFDYixZQUFZLEtBQWdFO0FBQzFFLG1CQUFXLEtBQUssR0FBRztBQUFBLE1BQ3JCO0FBQUEsSUFDRjtBQUNBLFVBQU0sUUFBUSxRQUFRLElBQUk7QUFDMUIsWUFBUSxNQUFNLElBQUk7QUFFbEIsUUFBSTtBQUNGLHlCQUFtQixNQUFNLEVBQUUsT0FBTyxnQkFBZ0IsV0FBVyxHQUFHLENBQUM7QUFDakUseUJBQW1CLE1BQU0sZ0JBQWdCO0FBQUEsUUFDdkMsWUFBWTtBQUFBLFVBQ1YsTUFBTTtBQUFBLFVBQ04sU0FBUztBQUFBLFVBQ1Qsa0JBQWtCO0FBQUEsUUFDcEI7QUFBQSxNQUNGLENBQUM7QUFFRCxZQUFNLFlBQVkseUJBQXlCLEtBQVksTUFBYTtBQUVwRSxhQUFPLE1BQU0sV0FBVyxRQUFRLENBQUM7QUFDakMsWUFBTSxXQUFXLFdBQVcsQ0FBQztBQUM3QixhQUFPLE1BQU0sU0FBUyxZQUFZLG9CQUFvQjtBQUN0RCxhQUFPLE1BQU0sU0FBUyxTQUFTLEtBQUs7QUFFcEMsYUFBTyxNQUFNLFNBQVMsU0FBUyx1QkFBdUI7QUFFdEQsYUFBTyxNQUFNLFNBQVMsU0FBUyxzQkFBc0I7QUFDckQsYUFBTyxNQUFNLFNBQVMsU0FBUyxvQkFBb0I7QUFDbkQsYUFBTyxNQUFNLFNBQVMsU0FBUywyQkFBMkI7QUFFMUQsYUFBTyxNQUFNLElBQUksY0FBYyxDQUFDLEVBQUUsU0FBUyw2QkFBNkI7QUFBQSxJQUMxRSxVQUFFO0FBQ0EsY0FBUSxNQUFNLEtBQUs7QUFDbkIsYUFBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDL0M7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLHFHQUFxRyxZQUFZO0FBQ3BILFVBQU0sT0FBTyxTQUFTO0FBQ3RCLFVBQU0sTUFBTSxjQUFjO0FBQzFCLFVBQU0sYUFBK0UsQ0FBQztBQUN0RixVQUFNLFNBQVM7QUFBQSxNQUNiLFlBQVksS0FBZ0U7QUFDMUUsbUJBQVcsS0FBSyxHQUFHO0FBQUEsTUFDckI7QUFBQSxJQUNGO0FBQ0EsVUFBTSxRQUFRLFFBQVEsSUFBSTtBQUMxQixZQUFRLE1BQU0sSUFBSTtBQUVsQixRQUFJO0FBQ0YseUJBQW1CLE1BQU0sRUFBRSxPQUFPLGNBQWMsV0FBVyxHQUFHLENBQUM7QUFDL0QseUJBQW1CLE1BQU0sY0FBYztBQUFBLFFBQ3JDLFNBQVMsRUFBRSxTQUFTLE1BQU0sT0FBTyxXQUFXLFVBQVUsZUFBZTtBQUFBLE1BQ3ZFLENBQUM7QUFFRCxZQUFNLFlBQVksdUJBQXVCLEtBQVksTUFBYTtBQUVsRSxhQUFPLE1BQU0sV0FBVyxRQUFRLENBQUM7QUFDakMsWUFBTSxXQUFXLFdBQVcsQ0FBQztBQUc3QixhQUFPLE1BQU0sU0FBUyxTQUFTLGtDQUFrQztBQUNqRSxhQUFPLGFBQWEsU0FBUyxTQUFTLDBCQUEwQjtBQUVoRSxhQUFPLE1BQU0sU0FBUyxTQUFTLFVBQVU7QUFDekMsYUFBTyxNQUFNLFNBQVMsU0FBUyxnQkFBZ0I7QUFFL0MsYUFBTyxNQUFNLElBQUksY0FBYyxDQUFDLEVBQUUsU0FBUyxrQkFBa0I7QUFBQSxJQUMvRCxVQUFFO0FBQ0EsY0FBUSxNQUFNLEtBQUs7QUFDbkIsYUFBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDL0M7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLGtHQUFrRyxZQUFZO0FBQ2pILFVBQU0sT0FBTyxTQUFTO0FBQ3RCLFVBQU0sTUFBTSxjQUFjO0FBQzFCLFVBQU0sYUFBK0UsQ0FBQztBQUN0RixVQUFNLFNBQVM7QUFBQSxNQUNiLFlBQVksS0FBZ0U7QUFDMUUsbUJBQVcsS0FBSyxHQUFHO0FBQUEsTUFDckI7QUFBQSxJQUNGO0FBQ0EsVUFBTSxRQUFRLFFBQVEsSUFBSTtBQUMxQixZQUFRLE1BQU0sSUFBSTtBQUVsQixRQUFJO0FBQ0YseUJBQW1CLE1BQU0sRUFBRSxPQUFPLGNBQWMsV0FBVyxHQUFHLENBQUM7QUFDL0QseUJBQW1CLE1BQU0sY0FBYztBQUFBLFFBQ3JDLFNBQVM7QUFBQSxVQUNQLFNBQVM7QUFBQSxVQUNULE9BQU87QUFBQSxVQUNQLFVBQVU7QUFBQSxVQUNWLFVBQVU7QUFBQSxVQUNWLGVBQWU7QUFBQSxRQUNqQjtBQUFBLE1BQ0YsQ0FBQztBQUVELFlBQU0sWUFBWSx1QkFBdUIsS0FBWSxNQUFhO0FBR2xFLGFBQU8sTUFBTSxXQUFXLFFBQVEsQ0FBQztBQUNqQyxhQUFPLE1BQU0sV0FBVyxDQUFDLEVBQUUsU0FBUyxnQkFBZ0I7QUFDcEQsYUFBTyxNQUFNLFdBQVcsQ0FBQyxFQUFFLFNBQVMsVUFBVTtBQUM5QyxhQUFPLE1BQU0sV0FBVyxDQUFDLEVBQUUsU0FBUyxhQUFhO0FBRWpELFlBQU0sWUFBWSxjQUFjO0FBQ2hDLFlBQU0sWUFBWSxxQkFBcUIsU0FBZ0I7QUFFdkQsWUFBTSxFQUFFLGtCQUFrQixLQUFLLElBQUksTUFBTSxPQUFPLDJCQUEyQjtBQUMzRSxZQUFNLFNBQVMsS0FBSyxNQUFNLFlBQVk7QUFDdEMsYUFBTyxHQUFHLFVBQVUsSUFBSTtBQUN4QixhQUFPLE1BQU0sT0FBUSxRQUFRLFNBQVMsT0FBTyxPQUFPO0FBRXBELGFBQU8sTUFBTSxJQUFJLGNBQWMsQ0FBQyxFQUFFLFNBQVMsb0JBQW9CO0FBQUEsSUFDakUsVUFBRTtBQUNBLGNBQVEsTUFBTSxLQUFLO0FBQ25CLGFBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQy9DO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyw2R0FBNkcsWUFBWTtBQUM1SCxVQUFNLE9BQU8sU0FBUztBQUN0QixVQUFNLE1BQU0sY0FBYztBQUMxQixVQUFNLGFBQStFLENBQUM7QUFDdEYsVUFBTSxTQUFTO0FBQUEsTUFDYixZQUFZLEtBQWdFO0FBQzFFLG1CQUFXLEtBQUssR0FBRztBQUFBLE1BQ3JCO0FBQUEsSUFDRjtBQUNBLFVBQU0sUUFBUSxRQUFRLElBQUk7QUFDMUIsWUFBUSxNQUFNLElBQUk7QUFFbEIsUUFBSTtBQUNGLHlCQUFtQixNQUFNLEVBQUUsT0FBTyxnQkFBZ0IsV0FBVyxJQUFJLFFBQVEsVUFBVSxPQUFPLFVBQVUsQ0FBQztBQUVyRyxZQUFNLFlBQVkseUJBQXlCLEtBQVksTUFBYTtBQUVwRSxhQUFPLE1BQU0sV0FBVyxRQUFRLENBQUM7QUFDakMsWUFBTSxXQUFXLFdBQVcsQ0FBQztBQUM3QixhQUFPLE1BQU0sU0FBUyxZQUFZLG9CQUFvQjtBQUV0RCxhQUFPLE1BQU0sU0FBUyxTQUFTLGdCQUFnQjtBQUMvQyxhQUFPLGFBQWEsU0FBUyxTQUFTLHNCQUFzQjtBQUM1RCxhQUFPLGFBQWEsU0FBUyxTQUFTLGFBQWE7QUFFbkQsYUFBTyxNQUFNLElBQUksY0FBYyxDQUFDLEVBQUUsU0FBUywyQkFBMkI7QUFBQSxJQUN4RSxVQUFFO0FBQ0EsY0FBUSxNQUFNLEtBQUs7QUFDbkIsYUFBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDL0M7QUFBQSxFQUNGLENBQUM7QUFDSCxDQUFDO0FBRUQsU0FBUyx5Q0FBeUMsTUFBTTtBQUN0RCxPQUFLLGtHQUFrRyxNQUFNO0FBQzNHLFVBQU0sVUFBVSxXQUFXLHlCQUF5QjtBQUFBLE1BQ2xELE1BQU07QUFBQSxNQUNOLE1BQU07QUFBQSxNQUNOLE9BQU87QUFBQSxNQUNQLGtCQUFrQjtBQUFBLE1BQ2xCLE1BQU07QUFBQSxNQUNOLG1CQUFtQjtBQUFBLE1BQ25CLFlBQVk7QUFBQSxNQUNaLG1CQUFtQjtBQUFBLElBQ3JCLENBQUM7QUFFRCxXQUFPLE1BQU0sU0FBUyxxQkFBcUI7QUFDM0MsV0FBTyxNQUFNLFNBQVMsbUJBQW1CO0FBQ3pDLFdBQU8sTUFBTSxTQUFTLHVCQUF1QjtBQUM3QyxXQUFPLE1BQU0sU0FBUyxtQkFBbUI7QUFDekMsV0FBTyxNQUFNLFNBQVMsK0JBQStCO0FBQUEsRUFDdkQsQ0FBQztBQUVELE9BQUssdURBQXVELE1BQU07QUFDaEUsVUFBTSxVQUFVLFdBQVcseUJBQXlCO0FBQUEsTUFDbEQsTUFBTTtBQUFBLE1BQ04sTUFBTTtBQUFBLE1BQ04sT0FBTztBQUFBLE1BQ1Asa0JBQWtCO0FBQUEsTUFDbEIsTUFBTTtBQUFBLE1BQ04sbUJBQW1CO0FBQUEsTUFDbkIsWUFBWTtBQUFBLE1BQ1osbUJBQW1CO0FBQUEsSUFDckIsQ0FBQztBQUVELFdBQU8sTUFBTSxTQUFTLG1CQUFtQjtBQUN6QyxXQUFPLE1BQU0sU0FBUyxrQ0FBa0M7QUFDeEQsV0FBTyxNQUFNLFNBQVMsWUFBWTtBQUNsQyxXQUFPLE1BQU0sU0FBUyxnQkFBZ0I7QUFBQSxFQUN4QyxDQUFDO0FBQ0gsQ0FBQztBQUVELFNBQVMsc0RBQWlELE1BQU07QUFDOUQsT0FBSyx1R0FBa0csWUFBWTtBQUNqSCxVQUFNLE9BQU8sU0FBUztBQUN0QixVQUFNLE1BQU0sY0FBYztBQUMxQixVQUFNLGFBQStFLENBQUM7QUFDdEYsVUFBTSxTQUFTO0FBQUEsTUFDYixZQUFZLEtBQWdFO0FBQzFFLG1CQUFXLEtBQUssR0FBRztBQUFBLE1BQ3JCO0FBQUEsSUFDRjtBQUNBLFVBQU0sUUFBUSxRQUFRLElBQUk7QUFDMUIsWUFBUSxNQUFNLElBQUk7QUFFbEIsUUFBSTtBQUNGLHlCQUFtQixNQUFNLEVBQUUsT0FBTyx5QkFBeUIsV0FBVyxHQUFHLENBQUM7QUFDMUUseUJBQW1CLE1BQU0seUJBQXlCO0FBQUEsUUFDaEQsWUFBWSxFQUFFLE1BQU0sZ0JBQWdCLFNBQVMsbUJBQW1CLGtCQUFrQixLQUFLO0FBQUEsUUFDdkYsa0JBQWtCO0FBQUEsVUFDaEIsTUFBTTtBQUFBLFVBQ04sT0FBTztBQUFBLFVBQ1AsU0FBUztBQUFBLFVBQ1QsUUFBUTtBQUFBLFVBQ1IsWUFBWTtBQUFBLFFBQ2Q7QUFBQSxNQUNGLENBQUM7QUFFRCxZQUFNLFlBQVksa0NBQWtDLEtBQVksTUFBYTtBQUU3RSxhQUFPLE1BQU0sV0FBVyxRQUFRLENBQUM7QUFDakMsWUFBTSxVQUFVLFdBQVcsQ0FBQyxFQUFFO0FBRTlCLGFBQU8sTUFBTSxTQUFTLHlCQUF5QjtBQUMvQyxhQUFPLE1BQU0sU0FBUyxrQkFBa0I7QUFDeEMsYUFBTyxNQUFNLFNBQVMseUJBQXlCO0FBQy9DLGFBQU8sTUFBTSxTQUFTLHVCQUF1QjtBQUU3QyxhQUFPLE1BQU0sSUFBSSxjQUFjLENBQUMsRUFBRSxTQUFTLDJCQUEyQjtBQUFBLElBQ3hFLFVBQUU7QUFDQSxjQUFRLE1BQU0sS0FBSztBQUNuQixhQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUMvQztBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssa0hBQTZHLFlBQVk7QUFDNUgsVUFBTSxPQUFPLFNBQVM7QUFDdEIsVUFBTSxNQUFNLGNBQWM7QUFDMUIsVUFBTSxhQUErRSxDQUFDO0FBQ3RGLFVBQU0sU0FBUztBQUFBLE1BQ2IsWUFBWSxLQUFnRTtBQUMxRSxtQkFBVyxLQUFLLEdBQUc7QUFBQSxNQUNyQjtBQUFBLElBQ0Y7QUFDQSxVQUFNLFFBQVEsUUFBUSxJQUFJO0FBQzFCLFlBQVEsTUFBTSxJQUFJO0FBRWxCLFFBQUk7QUFDRix5QkFBbUIsTUFBTSxFQUFFLE9BQU8sY0FBYyxXQUFXLEdBQUcsQ0FBQztBQUMvRCx5QkFBbUIsTUFBTSxjQUFjO0FBQUEsUUFDckMsWUFBWSxFQUFFLE1BQU0sZ0JBQWdCLFNBQVMsdUJBQXVCLGtCQUFrQixLQUFLO0FBQUEsTUFDN0YsQ0FBQztBQUVELFlBQU0sWUFBWSx1QkFBdUIsS0FBWSxNQUFhO0FBRWxFLGFBQU8sTUFBTSxXQUFXLFFBQVEsQ0FBQztBQUNqQyxZQUFNLFVBQVUsV0FBVyxDQUFDLEVBQUU7QUFFOUIsYUFBTyxhQUFhLFNBQVMseUJBQXlCO0FBQ3RELGFBQU8sYUFBYSxJQUFJLGNBQWMsQ0FBQyxFQUFFLFNBQVMsZ0JBQWdCO0FBQUEsSUFDcEUsVUFBRTtBQUNBLGNBQVEsTUFBTSxLQUFLO0FBQ25CLGFBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQy9DO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyx1RkFBa0YsWUFBWTtBQUNqRyxVQUFNLE9BQU8sU0FBUztBQUN0QixVQUFNLE1BQU0sY0FBYztBQUMxQixVQUFNLGFBQStFLENBQUM7QUFDdEYsVUFBTSxTQUFTO0FBQUEsTUFDYixZQUFZLEtBQWdFO0FBQzFFLG1CQUFXLEtBQUssR0FBRztBQUFBLE1BQ3JCO0FBQUEsSUFDRjtBQUNBLFVBQU0sUUFBUSxRQUFRLElBQUk7QUFDMUIsWUFBUSxNQUFNLElBQUk7QUFFbEIsUUFBSTtBQUNGLHlCQUFtQixNQUFNLEVBQUUsT0FBTyx3QkFBd0IsV0FBVyxHQUFHLENBQUM7QUFDekUseUJBQW1CLE1BQU0sd0JBQXdCO0FBQUEsUUFDL0MsWUFBWTtBQUFBLFVBQ1YsTUFBTTtBQUFBLFVBQ04sU0FBUztBQUFBLFVBQ1Qsa0JBQWtCO0FBQUEsVUFDbEIsY0FBYztBQUFBLFFBQ2hCO0FBQUEsUUFDQSxrQkFBa0I7QUFBQSxVQUNoQixNQUFNO0FBQUEsVUFDTixPQUFPO0FBQUEsVUFDUCxTQUFTO0FBQUEsVUFDVCxRQUFRO0FBQUEsVUFDUixZQUFZO0FBQUEsUUFDZDtBQUFBLE1BQ0YsQ0FBQztBQUVELFlBQU0sWUFBWSxpQ0FBaUMsS0FBWSxNQUFhO0FBRTVFLGFBQU8sTUFBTSxXQUFXLFFBQVEsQ0FBQztBQUNqQyxZQUFNLFVBQVUsV0FBVyxDQUFDLEVBQUU7QUFFOUIsYUFBTyxNQUFNLFNBQVMsbUJBQW1CO0FBQ3pDLGFBQU8sTUFBTSxTQUFTLHNCQUFzQjtBQUU1QyxhQUFPLE1BQU0sU0FBUyx5QkFBeUI7QUFDL0MsYUFBTyxNQUFNLFNBQVMsZ0JBQWdCO0FBQ3RDLGFBQU8sTUFBTSxTQUFTLHFCQUFxQjtBQUUzQyxhQUFPLE1BQU0sSUFBSSxjQUFjLENBQUMsRUFBRSxTQUFTLDZCQUE2QjtBQUN4RSxhQUFPLE1BQU0sSUFBSSxjQUFjLENBQUMsRUFBRSxTQUFTLHlCQUF5QjtBQUFBLElBQ3RFLFVBQUU7QUFDQSxjQUFRLE1BQU0sS0FBSztBQUNuQixhQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUMvQztBQUFBLEVBQ0YsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
