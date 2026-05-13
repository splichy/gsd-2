import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleGSDCommand } from "../commands/dispatcher.js";
import { handleDebug } from "../commands-debug.js";
import {
  createDebugSession,
  debugSessionArtifactPath,
  debugSessionsDir,
  loadDebugSession,
  updateDebugSession
} from "../debug-session-store.js";
function createMockPiWithDispatch() {
  const calls = [];
  return {
    calls,
    pi: {
      sendMessage(payload, options) {
        calls.push({ payload, options });
      }
    }
  };
}
function makeBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-debug-lifecycle-int-"));
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
      },
      custom: async () => {
      }
    },
    shutdown: async () => {
    }
  };
}
function lastNotification(ctx) {
  assert.ok(ctx.notifications.length > 0, "expected at least one UI notification");
  return ctx.notifications.at(-1);
}
test("/gsd debug lifecycle integration covers start/list/status/continue across multiple sessions", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    await handleGSDCommand("debug API returns 500 on checkout", ctx, {});
    const firstStarted = lastNotification(ctx);
    assert.equal(firstStarted.level, "info");
    assert.match(firstStarted.message, /Debug session started: api-returns-500-on-checkout/);
    await handleGSDCommand("debug API returns 500 on checkout", ctx, {});
    const secondStarted = lastNotification(ctx);
    assert.equal(secondStarted.level, "info");
    assert.match(secondStarted.message, /Debug session started: api-returns-500-on-checkout-2/);
    await handleGSDCommand("debug Checkout retries spin forever", ctx, {});
    const thirdStarted = lastNotification(ctx);
    assert.equal(thirdStarted.level, "info");
    assert.match(thirdStarted.message, /Debug session started: checkout-retries-spin-forever/);
    const sessionsDir = debugSessionsDir(base);
    const artifacts = readdirSync(sessionsDir).filter((name) => name.endsWith(".json")).sort();
    assert.deepEqual(artifacts, [
      "api-returns-500-on-checkout-2.json",
      "api-returns-500-on-checkout.json",
      "checkout-retries-spin-forever.json"
    ]);
    await handleGSDCommand("debug list", ctx, {});
    const listed = lastNotification(ctx);
    assert.equal(listed.level, "info");
    assert.match(listed.message, /Debug sessions:/);
    assert.match(listed.message, /api-returns-500-on-checkout/);
    assert.match(listed.message, /api-returns-500-on-checkout-2/);
    assert.match(listed.message, /checkout-retries-spin-forever/);
    assert.match(listed.message, /mode=debug status=active phase=queued/);
    await handleGSDCommand("debug status api-returns-500-on-checkout", ctx, {});
    const statusBeforeContinue = lastNotification(ctx);
    assert.equal(statusBeforeContinue.level, "info");
    assert.match(statusBeforeContinue.message, /^Debug session status: api-returns-500-on-checkout/m);
    assert.match(statusBeforeContinue.message, /^mode=debug$/m);
    assert.match(statusBeforeContinue.message, /^status=active$/m);
    assert.match(statusBeforeContinue.message, /^phase=queued$/m);
    assert.match(statusBeforeContinue.message, /^updated=\d{4}-\d{2}-\d{2}T/m);
    await handleGSDCommand("debug continue api-returns-500-on-checkout-2", ctx, {});
    const resumed = lastNotification(ctx);
    assert.equal(resumed.level, "info");
    assert.match(resumed.message, /Resumed debug session: api-returns-500-on-checkout-2/);
    assert.match(resumed.message, /status=active/);
    assert.match(resumed.message, /phase=continued/);
    await handleGSDCommand("debug status api-returns-500-on-checkout-2", ctx, {});
    const statusAfterContinue = lastNotification(ctx);
    assert.equal(statusAfterContinue.level, "info");
    assert.match(statusAfterContinue.message, /^phase=continued$/m);
    assert.match(statusAfterContinue.message, /^updated=\d{4}-\d{2}-\d{2}T/m);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug lifecycle integration handles invalid slugs and malformed artifacts with actionable diagnostics", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    await handleGSDCommand("debug Sync bug in checkout", ctx, {});
    const started = lastNotification(ctx);
    assert.equal(started.level, "info");
    assert.match(started.message, /Debug session started: sync-bug-in-checkout/);
    await handleGSDCommand("debug status no-such-session", ctx, {});
    const missingStatus = lastNotification(ctx);
    assert.equal(missingStatus.level, "warning");
    assert.match(missingStatus.message, /Unknown debug session slug 'no-such-session'/);
    assert.match(missingStatus.message, /Run \/gsd debug list/);
    await handleGSDCommand("debug continue no-such-session", ctx, {});
    const missingContinue = lastNotification(ctx);
    assert.equal(missingContinue.level, "warning");
    assert.match(missingContinue.message, /Unknown debug session slug 'no-such-session'/);
    const brokenArtifactPath = debugSessionArtifactPath(base, "broken-session");
    writeFileSync(brokenArtifactPath, "{ definitely-not-valid-json", "utf-8");
    await handleGSDCommand("debug status broken-session", ctx, {});
    const corruptedStatus = lastNotification(ctx);
    assert.equal(corruptedStatus.level, "warning");
    assert.match(corruptedStatus.message, /Unable to load debug session 'broken-session'/);
    assert.match(corruptedStatus.message, /Try \/gsd debug --diagnose broken-session/);
    await handleGSDCommand("debug list", ctx, {});
    const listed = lastNotification(ctx);
    assert.equal(listed.level, "info");
    assert.match(listed.message, /Malformed artifacts: 1/);
    assert.match(listed.message, /broken-session\.json/);
    assert.match(listed.message, /Run \/gsd debug --diagnose for remediation guidance/);
    await handleGSDCommand("debug --diagnose", ctx, {});
    const diagnosed = lastNotification(ctx);
    assert.equal(diagnosed.level, "warning");
    assert.match(diagnosed.message, /Debug session diagnostics:/);
    assert.match(diagnosed.message, /malformedArtifacts=1/);
    assert.match(diagnosed.message, /Remediation: repair\/remove malformed JSON artifacts under \.gsd\/debug\/sessions\//);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug lifecycle integration keeps session artifacts isolated from debug logs and preserves slug determinism", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    const debugDir = join(base, ".gsd", "debug");
    mkdirSync(debugDir, { recursive: true });
    writeFileSync(join(debugDir, "payment-timeout.log"), "log seed\n", "utf-8");
    await handleGSDCommand("debug Payment timeout", ctx, {});
    const firstStarted = lastNotification(ctx);
    assert.equal(firstStarted.level, "info");
    assert.match(firstStarted.message, /Debug session started: payment-timeout/);
    await handleGSDCommand("debug Payment timeout", ctx, {});
    const secondStarted = lastNotification(ctx);
    assert.equal(secondStarted.level, "info");
    assert.match(secondStarted.message, /Debug session started: payment-timeout-2/);
    assert.equal(existsSync(join(base, ".gsd", "debug", "payment-timeout.json")), false);
    assert.equal(existsSync(join(base, ".gsd", "debug", "sessions", "payment-timeout.json")), true);
    assert.equal(existsSync(join(base, ".gsd", "debug", "sessions", "payment-timeout-2.json")), true);
    await handleGSDCommand("logs debug", ctx, {});
    const logsListed = lastNotification(ctx);
    assert.equal(logsListed.level, "info");
    assert.match(logsListed.message, /Debug Logs \(\.gsd\/debug\/\):/);
    assert.match(logsListed.message, /payment-timeout\.log/);
    assert.doesNotMatch(logsListed.message, /payment-timeout\.json/);
    await handleGSDCommand("debug list", ctx, {});
    const sessionsListed = lastNotification(ctx);
    assert.equal(sessionsListed.level, "info");
    assert.match(sessionsListed.message, /payment-timeout/);
    assert.match(sessionsListed.message, /payment-timeout-2/);
    assert.match(sessionsListed.message, /mode=debug status=active phase=queued/);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug --diagnose <issue> dispatches find_root_cause_only goal and records mode=diagnose session", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();
    await handleDebug("--diagnose auth token rotation breaks sessions", ctx, pi);
    const n = lastNotification(ctx);
    assert.equal(n.level, "info");
    assert.match(n.message, /Diagnose session started:/);
    assert.match(n.message, /mode=diagnose/);
    assert.match(n.message, /dispatchMode=find_root_cause_only/);
    assert.equal(calls.length, 1, "should dispatch exactly one message");
    const call = calls[0];
    assert.equal(call.payload.customType, "gsd-debug-diagnose");
    assert.match(call.payload.content, /find_root_cause_only/);
    assert.match(call.payload.content, /auth token rotation breaks sessions/i);
    assert.equal(call.options.triggerTurn, true);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug continue <slug> dispatches find_and_fix goal scoped to target slug", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();
    await handleDebug("Race condition in payment handler", ctx, {});
    await handleDebug("Stale cache on checkout", ctx, {});
    calls.length = 0;
    await handleDebug("continue race-condition-in-payment-handler", ctx, pi);
    const n = lastNotification(ctx);
    assert.equal(n.level, "info");
    assert.match(n.message, /Resumed debug session: race-condition-in-payment-handler/);
    assert.match(n.message, /phase=continued/);
    assert.match(n.message, /dispatchMode=find_and_fix/);
    assert.equal(calls.length, 1, "should dispatch exactly one message");
    const call = calls[0];
    assert.equal(call.payload.customType, "gsd-debug-continue");
    assert.match(call.payload.content, /find_and_fix/);
    assert.match(call.payload.content, /race-condition-in-payment-handler/);
    assert.doesNotMatch(call.payload.content, /stale-cache-on-checkout/);
    assert.equal(call.options.triggerTurn, true);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug --diagnose (zero-arg) with no pi still reports malformed artifact counts without dispatch", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();
    const sessionsDir = debugSessionsDir(base);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "broken-a.json"), "{bad json", "utf-8");
    writeFileSync(join(sessionsDir, "broken-b.json"), "null", "utf-8");
    await handleGSDCommand("debug --diagnose", ctx, {});
    const n = lastNotification(ctx);
    assert.equal(n.level, "warning");
    assert.match(n.message, /Debug session diagnostics:/);
    assert.match(n.message, /malformedArtifacts=2/);
    assert.match(n.message, /Remediation:/);
    await handleDebug("--diagnose", ctx, pi);
    assert.equal(calls.length, 0, "zero-arg --diagnose must not dispatch even with pi present");
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug negative: continue unknown slug emits warning, continue resolved session emits warning", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();
    await handleDebug("continue totally-nonexistent-slug", ctx, pi);
    const notFound = lastNotification(ctx);
    assert.equal(notFound.level, "warning");
    assert.match(notFound.message, /Unknown debug session slug 'totally-nonexistent-slug'/);
    assert.equal(calls.length, 0, "no dispatch for unknown slug");
    await handleDebug("status", ctx, {});
    const noSlug = lastNotification(ctx);
    assert.equal(noSlug.level, "warning");
    assert.match(noSlug.message, /Missing slug/);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug negative: multiple sessions with similar slugs \u2014 status and continue target exact match only", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    await handleGSDCommand("debug Login token expires", ctx, {});
    await handleGSDCommand("debug Login token expires too fast", ctx, {});
    await handleGSDCommand("debug list", ctx, {});
    const listed = lastNotification(ctx);
    assert.match(listed.message, /login-token-expires\b/);
    assert.match(listed.message, /login-token-expires-too-fast\b/);
    await handleGSDCommand("debug status login-token-expires", ctx, {});
    const baseStatus = lastNotification(ctx);
    assert.match(baseStatus.message, /^Debug session status: login-token-expires$/m);
    assert.doesNotMatch(baseStatus.message, /login-token-expires-too-fast/);
    await handleGSDCommand("debug status login-token-expires-too-fast", ctx, {});
    const suffixedStatus = lastNotification(ctx);
    assert.match(suffixedStatus.message, /^Debug session status: login-token-expires-too-fast$/m);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug S03: checkpoint resume dispatches enriched payload via debug-session-manager template", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();
    const created = createDebugSession(base, { issue: "Login fails after deploy" });
    const slug = created.session.slug;
    updateDebugSession(base, slug, {
      checkpoint: {
        type: "human-verify",
        summary: "Verify fix on staging",
        awaitingResponse: true
      }
    });
    await handleDebug(`continue ${slug}`, ctx, pi);
    const n = lastNotification(ctx);
    assert.equal(n.level, "info");
    assert.match(n.message, new RegExp(`Resumed debug session: ${slug}`));
    assert.match(n.message, /phase=continued/);
    assert.match(n.message, /dispatchMode=checkpointType=human-verify/);
    assert.equal(calls.length, 1, "should dispatch exactly one message");
    const call = calls[0];
    assert.equal(call.payload.customType, "gsd-debug-continue");
    assert.match(call.payload.content, /Structured Return Protocol/);
    assert.match(call.payload.content, /## Active Checkpoint/);
    assert.match(call.payload.content, /type: human-verify/);
    assert.match(call.payload.content, /summary: Verify fix on staging/);
    assert.match(call.payload.content, /awaitingResponse: true/);
    assert.equal(call.options.triggerTurn, true);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug S03: TDD gate pending dispatches find_root_cause_only with TDD instructions", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();
    const created = createDebugSession(base, { issue: "Auth refresh races on mobile" });
    const slug = created.session.slug;
    updateDebugSession(base, slug, {
      tddGate: { enabled: true, phase: "pending" }
    });
    await handleDebug(`continue ${slug}`, ctx, pi);
    const n = lastNotification(ctx);
    assert.equal(n.level, "info");
    assert.match(n.message, new RegExp(`Resumed debug session: ${slug}`));
    assert.match(n.message, /dispatchMode=tddPhase=pending/);
    assert.equal(calls.length, 1, "should dispatch exactly one message");
    const call = calls[0];
    assert.equal(call.payload.customType, "gsd-debug-continue");
    assert.match(call.payload.content, /## Goal\s+`find_root_cause_only`/);
    assert.doesNotMatch(call.payload.content, /## Goal\s+`find_and_fix`/);
    assert.match(call.payload.content, /## TDD Gate/);
    assert.match(call.payload.content, /phase: pending/);
    assert.match(call.payload.content, /TDD mode is active/);
    assert.match(call.payload.content, /Structured Return Protocol/);
    assert.equal(call.options.triggerTurn, true);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug S03: TDD gate red dispatches find_and_fix and advances phase to green", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();
    const created = createDebugSession(base, { issue: "Auth token expiry not handled" });
    const slug = created.session.slug;
    updateDebugSession(base, slug, {
      tddGate: {
        enabled: true,
        phase: "red",
        testFile: "auth.test.ts",
        testName: "rejects expired token"
      }
    });
    await handleDebug(`continue ${slug}`, ctx, pi);
    const n = lastNotification(ctx);
    assert.equal(n.level, "info");
    assert.match(n.message, new RegExp(`Resumed debug session: ${slug}`));
    assert.match(n.message, /dispatchMode=tddPhase=red/);
    assert.equal(calls.length, 1, "should dispatch exactly one message");
    const call = calls[0];
    assert.equal(call.payload.customType, "gsd-debug-continue");
    assert.match(call.payload.content, /## Goal\s+`find_and_fix`/);
    assert.match(call.payload.content, /## TDD Gate/);
    assert.match(call.payload.content, /phase: red/);
    assert.match(call.payload.content, /testFile: auth\.test\.ts/);
    assert.match(call.payload.content, /testName: rejects expired token/);
    assert.equal(call.options.triggerTurn, true);
    const reloaded = loadDebugSession(base, slug);
    assert.ok(reloaded, "session should still exist after continue");
    assert.equal(reloaded.session.tddGate?.phase, "green", "tddGate.phase must advance red\u2192green");
    assert.equal(reloaded.session.phase, "continued");
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug S03: backward compat \u2014 legacy session without checkpoint/TDD uses debug-diagnose template", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();
    const created = createDebugSession(base, { issue: "Payment retries hang indefinitely" });
    const slug = created.session.slug;
    await handleDebug(`continue ${slug}`, ctx, pi);
    const n = lastNotification(ctx);
    assert.equal(n.level, "info");
    assert.match(n.message, new RegExp(`Resumed debug session: ${slug}`));
    assert.match(n.message, /phase=continued/);
    assert.match(n.message, /dispatchMode=find_and_fix/);
    assert.equal(calls.length, 1, "should dispatch exactly one message");
    const call = calls[0];
    assert.equal(call.payload.customType, "gsd-debug-continue");
    assert.doesNotMatch(call.payload.content, /Structured Return Protocol/);
    assert.doesNotMatch(call.payload.content, /## Active Checkpoint/);
    assert.doesNotMatch(call.payload.content, /## TDD Gate/);
    assert.match(call.payload.content, /find_and_fix/);
    assert.equal(call.options.triggerTurn, true);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug S03: round-trip \u2014 checkpoint with userResponse dispatches response and session transitions to continued", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();
    const created = createDebugSession(base, { issue: "Cache invalidation race on deploy" });
    const slug = created.session.slug;
    updateDebugSession(base, slug, {
      checkpoint: {
        type: "human-verify",
        summary: "Check whether stale keys appear after deploy",
        awaitingResponse: true,
        userResponse: "Confirmed on staging"
      }
    });
    await handleDebug(`continue ${slug}`, ctx, pi);
    const n = lastNotification(ctx);
    assert.equal(n.level, "info");
    assert.match(n.message, new RegExp(`Resumed debug session: ${slug}`));
    assert.match(n.message, /phase=continued/);
    assert.equal(calls.length, 1, "should dispatch exactly one message");
    const call = calls[0];
    assert.equal(call.payload.customType, "gsd-debug-continue");
    assert.match(call.payload.content, /DATA_START/);
    assert.match(call.payload.content, /Confirmed on staging/);
    assert.match(call.payload.content, /DATA_END/);
    assert.equal(call.options.triggerTurn, true);
    const reloaded = loadDebugSession(base, slug);
    assert.ok(reloaded, "session should still exist");
    assert.equal(reloaded.session.phase, "continued");
    assert.equal(reloaded.session.status, "active");
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug S04: specialist review round-trip through continue dispatch", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();
    const created = createDebugSession(base, { issue: "Unsafe type assertion in auth flow" });
    const slug = created.session.slug;
    updateDebugSession(base, slug, {
      checkpoint: {
        type: "human-verify",
        summary: "Verify type guard is safe on all auth paths",
        awaitingResponse: true
      },
      specialistReview: {
        hint: "typescript",
        skill: "typescript-expert",
        verdict: "SUGGEST_CHANGE (use type guard)",
        detail: "The current implementation uses unsafe type assertion",
        reviewedAt: 17e11
      }
    });
    await handleDebug(`continue ${slug}`, ctx, pi);
    const n = lastNotification(ctx);
    assert.equal(n.level, "info");
    assert.match(n.message, new RegExp(`Resumed debug session: ${slug}`));
    assert.match(n.message, /phase=continued/);
    assert.match(n.message, /specialistHint=typescript/);
    assert.equal(calls.length, 1, "should dispatch exactly one message");
    const call = calls[0];
    assert.equal(call.payload.customType, "gsd-debug-continue");
    assert.match(call.payload.content, /Structured Return Protocol/);
    assert.match(call.payload.content, /Prior Specialist Review/);
    assert.match(call.payload.content, /hint: typescript/);
    assert.match(call.payload.content, /SUGGEST_CHANGE \(use type guard\)/);
    assert.match(call.payload.content, /The current implementation uses unsafe type assertion/);
    assert.equal(call.options.triggerTurn, true);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug S04: backward compat \u2014 session without specialistReview continues normally", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();
    const created = createDebugSession(base, { issue: "Memory leak in event bus" });
    const slug = created.session.slug;
    updateDebugSession(base, slug, {
      checkpoint: {
        type: "human-verify",
        summary: "Confirm leak disappears after fix",
        awaitingResponse: true
      }
    });
    await handleDebug(`continue ${slug}`, ctx, pi);
    const n = lastNotification(ctx);
    assert.equal(n.level, "info");
    assert.match(n.message, new RegExp(`Resumed debug session: ${slug}`));
    assert.match(n.message, /phase=continued/);
    assert.doesNotMatch(n.message, /specialistHint=/);
    assert.equal(calls.length, 1, "should dispatch exactly one message");
    const call = calls[0];
    assert.equal(call.payload.customType, "gsd-debug-continue");
    assert.match(call.payload.content, /Structured Return Protocol/);
    assert.doesNotMatch(call.payload.content, /Prior Specialist Review/);
    assert.equal(call.options.triggerTurn, true);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug S04: specialist review persists through continue with disk reload", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();
    const created = createDebugSession(base, { issue: "Race condition in payment finalizer" });
    const slug = created.session.slug;
    updateDebugSession(base, slug, {
      checkpoint: {
        type: "root-cause-found",
        summary: "Race between finalizer and GC hook confirmed",
        awaitingResponse: true
      },
      specialistReview: {
        hint: "typescript",
        skill: "typescript-expert",
        verdict: "LOOKS_GOOD",
        detail: "WeakRef pattern correctly avoids the GC race",
        reviewedAt: 1700000001e3
      }
    });
    await handleDebug(`continue ${slug}`, ctx, pi);
    assert.equal(calls.length, 1, "should dispatch exactly one message");
    const reloaded = loadDebugSession(base, slug);
    assert.ok(reloaded, "session must still exist on disk after continue");
    assert.equal(reloaded.session.phase, "continued", "phase must be updated to continued");
    assert.equal(reloaded.session.status, "active", "status must be active");
    assert.ok(reloaded.session.specialistReview != null, "specialistReview must be preserved (not wiped by continue)");
    assert.equal(reloaded.session.specialistReview.hint, "typescript");
    assert.equal(reloaded.session.specialistReview.verdict, "LOOKS_GOOD");
    assert.equal(reloaded.session.specialistReview.skill, "typescript-expert");
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug S05: full happy-path lifecycle \u2014 start \u2192 list \u2192 status \u2192 continue \u2192 resolve \u2192 continue-blocked", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();
    await handleGSDCommand("debug Widget fails on mobile", ctx, {});
    const started = lastNotification(ctx);
    assert.equal(started.level, "info");
    assert.match(started.message, /Debug session started: widget-fails-on-mobile/);
    const slug = "widget-fails-on-mobile";
    await handleGSDCommand("debug list", ctx, {});
    const listed = lastNotification(ctx);
    assert.equal(listed.level, "info");
    assert.match(listed.message, /Debug sessions:/);
    assert.match(listed.message, /widget-fails-on-mobile/);
    assert.match(listed.message, /mode=debug status=active phase=queued/);
    await handleGSDCommand(`debug status ${slug}`, ctx, {});
    const status = lastNotification(ctx);
    assert.equal(status.level, "info");
    assert.match(status.message, new RegExp(`^Debug session status: ${slug}`, "m"));
    assert.match(status.message, /^mode=debug$/m);
    assert.match(status.message, /^status=active$/m);
    assert.match(status.message, /^phase=queued$/m);
    await handleDebug(`continue ${slug}`, ctx, pi);
    const resumed = lastNotification(ctx);
    assert.equal(resumed.level, "info");
    assert.match(resumed.message, new RegExp(`Resumed debug session: ${slug}`));
    assert.match(resumed.message, /dispatchMode=find_and_fix/);
    assert.equal(calls.length, 1, "should dispatch exactly one message on continue");
    const call = calls[0];
    assert.equal(call.payload.customType, "gsd-debug-continue");
    assert.match(call.payload.content, /find_and_fix/);
    assert.equal(call.options.triggerTurn, true);
    updateDebugSession(base, slug, { status: "resolved" });
    calls.length = 0;
    await handleDebug(`continue ${slug}`, ctx, pi);
    const blockedWarning = lastNotification(ctx);
    assert.equal(blockedWarning.level, "warning");
    assert.match(blockedWarning.message, new RegExp(`Session '${slug}' is resolved`));
    assert.equal(calls.length, 0, "no dispatch for resolved session");
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug S05: diagnose-only full lifecycle \u2014 start \u2192 status(mode=diagnose) \u2192 continue uses debug-diagnose template", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();
    await handleDebug("--diagnose Memory leak in worker pool", ctx, pi);
    const started = lastNotification(ctx);
    assert.equal(started.level, "info");
    assert.match(started.message, /Diagnose session started:/);
    assert.match(started.message, /mode=diagnose/);
    assert.match(started.message, /dispatchMode=find_root_cause_only/);
    assert.equal(calls.length, 1, "should dispatch exactly one message on diagnose-start");
    const diagnoseCall = calls[0];
    assert.equal(diagnoseCall.payload.customType, "gsd-debug-diagnose");
    assert.match(diagnoseCall.payload.content, /find_root_cause_only/);
    assert.match(diagnoseCall.payload.content, /Memory leak in worker pool/i);
    assert.equal(diagnoseCall.options.triggerTurn, true);
    const slug = "memory-leak-in-worker-pool";
    await handleGSDCommand(`debug status ${slug}`, ctx, {});
    const status = lastNotification(ctx);
    assert.equal(status.level, "info");
    assert.match(status.message, /^mode=diagnose$/m);
    assert.match(status.message, /^status=active$/m);
    calls.length = 0;
    await handleDebug(`continue ${slug}`, ctx, pi);
    const resumed = lastNotification(ctx);
    assert.equal(resumed.level, "info");
    assert.match(resumed.message, new RegExp(`Resumed debug session: ${slug}`));
    assert.match(resumed.message, /dispatchMode=find_and_fix/);
    assert.equal(calls.length, 1, "should dispatch exactly one message on continue");
    const continueCall = calls[0];
    assert.equal(continueCall.payload.customType, "gsd-debug-continue");
    assert.doesNotMatch(continueCall.payload.content, /Structured Return Protocol/);
    assert.match(continueCall.payload.content, /find_and_fix/);
    assert.equal(continueCall.options.triggerTurn, true);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug S05: TDD full cycle \u2014 pending \u2192 red \u2192 green with disk-reload verification at each phase", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();
    const created = createDebugSession(base, { issue: "Widget state resets on re-render" });
    const slug = created.session.slug;
    updateDebugSession(base, slug, {
      tddGate: { enabled: true, phase: "pending" }
    });
    await handleDebug(`continue ${slug}`, ctx, pi);
    const pendingNotif = lastNotification(ctx);
    assert.match(pendingNotif.message, /dispatchMode=tddPhase=pending/);
    assert.equal(calls.length, 1);
    const pendingCall = calls[0];
    assert.match(pendingCall.payload.content, /## Goal\s+`find_root_cause_only`/);
    assert.match(pendingCall.payload.content, /phase: pending/);
    assert.match(pendingCall.payload.content, /Structured Return Protocol/);
    const afterPending = loadDebugSession(base, slug);
    assert.ok(afterPending, "session must exist after pending continue");
    assert.equal(afterPending.session.tddGate?.phase, "pending", "pending phase must not advance on disk");
    assert.equal(afterPending.session.phase, "continued");
    updateDebugSession(base, slug, {
      tddGate: { enabled: true, phase: "red", testFile: "widget.test.ts", testName: "resets on re-render" }
    });
    calls.length = 0;
    await handleDebug(`continue ${slug}`, ctx, pi);
    const redNotif = lastNotification(ctx);
    assert.match(redNotif.message, /dispatchMode=tddPhase=red/);
    assert.equal(calls.length, 1);
    const redCall = calls[0];
    assert.match(redCall.payload.content, /## Goal\s+`find_and_fix`/);
    assert.match(redCall.payload.content, /phase: red/);
    assert.match(redCall.payload.content, /testFile: widget\.test\.ts/);
    assert.match(redCall.payload.content, /testName: resets on re-render/);
    const afterRed = loadDebugSession(base, slug);
    assert.ok(afterRed, "session must exist after red continue");
    assert.equal(afterRed.session.tddGate?.phase, "green", "tddGate.phase must advance red\u2192green on disk");
    assert.equal(afterRed.session.phase, "continued");
    calls.length = 0;
    await handleDebug(`continue ${slug}`, ctx, pi);
    const greenNotif = lastNotification(ctx);
    assert.match(greenNotif.message, /dispatchMode=tddPhase=green/);
    assert.equal(calls.length, 1);
    const greenCall = calls[0];
    assert.match(greenCall.payload.content, /## Goal\s+`find_and_fix`/);
    assert.match(greenCall.payload.content, /phase: green/);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug S05: combined checkpoint + specialist review + TDD gate \u2014 all three sections present in dispatch payload", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();
    const created = createDebugSession(base, { issue: "Widget render loop detected" });
    const slug = created.session.slug;
    updateDebugSession(base, slug, {
      checkpoint: {
        type: "root-cause-found",
        summary: "Confirmed infinite re-render due to unstable reference",
        awaitingResponse: true
      },
      specialistReview: {
        hint: "typescript",
        skill: "typescript-expert",
        verdict: "SUGGEST_CHANGE",
        detail: "Use useMemo to stabilize the reference",
        reviewedAt: 1700000002e3
      },
      tddGate: {
        enabled: true,
        phase: "red",
        testFile: "widget.test.ts",
        testName: "does not loop on stable props"
      }
    });
    await handleDebug(`continue ${slug}`, ctx, pi);
    const n = lastNotification(ctx);
    assert.equal(n.level, "info");
    assert.match(n.message, new RegExp(`Resumed debug session: ${slug}`));
    assert.match(n.message, /phase=continued/);
    assert.match(n.message, /specialistHint=typescript/);
    assert.match(n.message, /tddPhase=red/);
    assert.equal(calls.length, 1, "should dispatch exactly one message");
    const call = calls[0];
    assert.equal(call.payload.customType, "gsd-debug-continue");
    assert.match(call.payload.content, /Structured Return Protocol/);
    assert.match(call.payload.content, /## Active Checkpoint/);
    assert.match(call.payload.content, /type: root-cause-found/);
    assert.match(call.payload.content, /Prior Specialist Review/);
    assert.match(call.payload.content, /hint: typescript/);
    assert.match(call.payload.content, /## TDD Gate/);
    assert.match(call.payload.content, /phase: red/);
    assert.match(call.payload.content, /testFile: widget\.test\.ts/);
    assert.equal(call.options.triggerTurn, true);
    const reloaded = loadDebugSession(base, slug);
    assert.ok(reloaded, "session must exist after combined continue");
    assert.equal(reloaded.session.tddGate?.phase, "green", "tddGate.phase must advance red\u2192green on disk");
    assert.equal(reloaded.session.phase, "continued");
    assert.ok(reloaded.session.specialistReview != null, "specialistReview must be preserved after continue");
    assert.equal(reloaded.session.specialistReview.hint, "typescript");
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug S05: multi-session concurrent lifecycle \u2014 3 sessions continue independently and list shows all as continued", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    await handleGSDCommand("debug Auth token expires silently", ctx, {});
    assert.match(lastNotification(ctx).message, /Debug session started: auth-token-expires-silently/);
    await handleGSDCommand("debug Cache misses on cold start", ctx, {});
    assert.match(lastNotification(ctx).message, /Debug session started: cache-misses-on-cold-start/);
    await handleGSDCommand("debug Payment webhook drops under load", ctx, {});
    assert.match(lastNotification(ctx).message, /Debug session started: payment-webhook-drops-under-load/);
    const { calls: calls1, pi: pi1 } = createMockPiWithDispatch();
    await handleDebug("continue auth-token-expires-silently", ctx, pi1);
    assert.equal(calls1.length, 1, "session 1 should dispatch exactly one message");
    assert.match(calls1[0].payload.content, /auth-token-expires-silently/);
    assert.doesNotMatch(calls1[0].payload.content, /cache-misses-on-cold-start/);
    assert.doesNotMatch(calls1[0].payload.content, /payment-webhook-drops-under-load/);
    const { calls: calls2, pi: pi2 } = createMockPiWithDispatch();
    await handleDebug("continue cache-misses-on-cold-start", ctx, pi2);
    assert.equal(calls2.length, 1, "session 2 should dispatch exactly one message");
    assert.match(calls2[0].payload.content, /cache-misses-on-cold-start/);
    assert.doesNotMatch(calls2[0].payload.content, /auth-token-expires-silently/);
    const { calls: calls3, pi: pi3 } = createMockPiWithDispatch();
    await handleDebug("continue payment-webhook-drops-under-load", ctx, pi3);
    assert.equal(calls3.length, 1, "session 3 should dispatch exactly one message");
    assert.match(calls3[0].payload.content, /payment-webhook-drops-under-load/);
    assert.doesNotMatch(calls3[0].payload.content, /auth-token-expires-silently/);
    await handleGSDCommand("debug list", ctx, {});
    const listed = lastNotification(ctx);
    assert.equal(listed.level, "info");
    assert.match(listed.message, /auth-token-expires-silently/);
    assert.match(listed.message, /cache-misses-on-cold-start/);
    assert.match(listed.message, /payment-webhook-drops-under-load/);
    assert.match(listed.message, /phase=continued/);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug S05: resolved session blocks continue via dispatcher route \u2014 warning emitted, zero dispatches", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();
    await handleGSDCommand("debug Stale lock file blocks deploy", ctx, {});
    const started = lastNotification(ctx);
    assert.equal(started.level, "info");
    assert.match(started.message, /Debug session started: stale-lock-file-blocks-deploy/);
    const slug = "stale-lock-file-blocks-deploy";
    updateDebugSession(base, slug, { status: "resolved" });
    await handleGSDCommand(`debug continue ${slug}`, ctx, pi);
    const warned = lastNotification(ctx);
    assert.equal(warned.level, "warning");
    assert.match(warned.message, new RegExp(`Session '${slug}' is resolved`));
    assert.equal(calls.length, 0, "no dispatch for resolved session via dispatcher route");
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug S05: TDD gate green-phase continue dispatches find_and_fix with green context and 'test is now passing' text", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();
    const created = createDebugSession(base, { issue: "Button click handler fires twice" });
    const slug = created.session.slug;
    updateDebugSession(base, slug, {
      tddGate: {
        enabled: true,
        phase: "green",
        testFile: "button.test.ts",
        testName: "fires handler once per click"
      }
    });
    await handleDebug(`continue ${slug}`, ctx, pi);
    const n = lastNotification(ctx);
    assert.equal(n.level, "info");
    assert.match(n.message, new RegExp(`Resumed debug session: ${slug}`));
    assert.match(n.message, /phase=continued/);
    assert.match(n.message, /dispatchMode=tddPhase=green/);
    assert.equal(calls.length, 1, "should dispatch exactly one message");
    const call = calls[0];
    assert.equal(call.payload.customType, "gsd-debug-continue");
    assert.match(call.payload.content, /## Goal\s+`find_and_fix`/);
    assert.match(call.payload.content, /## TDD Gate/);
    assert.match(call.payload.content, /phase: green/);
    assert.match(call.payload.content, /The test is now passing/);
    assert.match(call.payload.content, /testFile: button\.test\.ts/);
    assert.match(call.payload.content, /testName: fires handler once per click/);
    assert.equal(call.options.triggerTurn, true);
    const reloaded = loadDebugSession(base, slug);
    assert.ok(reloaded, "session must exist after green continue");
    assert.equal(reloaded.session.phase, "continued");
    assert.equal(reloaded.session.tddGate?.phase, "green", "green phase must remain green (no further advance)");
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
test("/gsd debug S05: dispatch failure resilience \u2014 sendMessage throws, session remains resumable and retry succeeds", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);
  try {
    const ctx = createMockCtx();
    const created = createDebugSession(base, { issue: "Payment processor timeout on retry" });
    const slug = created.session.slug;
    updateDebugSession(base, slug, {
      checkpoint: {
        type: "human-verify",
        summary: "Confirm retry logic terminates",
        awaitingResponse: true
      }
    });
    const throwingPi = {
      sendMessage(_payload, _options) {
        throw new Error("Network error: sendMessage failed");
      }
    };
    await handleDebug(`continue ${slug}`, ctx, throwingPi);
    const failNotif = lastNotification(ctx);
    assert.equal(failNotif.level, "warning");
    assert.match(failNotif.message, /Continue dispatch failed/);
    assert.match(failNotif.message, new RegExp(slug));
    const reloaded = loadDebugSession(base, slug);
    assert.ok(reloaded, "session must still exist on disk after dispatch failure");
    assert.equal(reloaded.session.phase, "continued", "phase must be continued despite failed dispatch");
    assert.equal(reloaded.session.status, "active");
    const { calls: retryCalls, pi: workingPi } = createMockPiWithDispatch();
    await handleDebug(`continue ${slug}`, ctx, workingPi);
    const retryNotif = lastNotification(ctx);
    assert.equal(retryNotif.level, "info");
    assert.match(retryNotif.message, new RegExp(`Resumed debug session: ${slug}`));
    assert.equal(retryCalls.length, 1, "retry should dispatch exactly one message");
    const retryCall = retryCalls[0];
    assert.equal(retryCall.payload.customType, "gsd-debug-continue");
    assert.equal(retryCall.options.triggerTurn, true);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kZWJ1Zy1jb21tYW5kLWxpZmVjeWNsZS5pbnRlZ3JhdGlvbi50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJlYWRkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7IGhhbmRsZUdTRENvbW1hbmQgfSBmcm9tIFwiLi4vY29tbWFuZHMvZGlzcGF0Y2hlci50c1wiO1xuaW1wb3J0IHsgaGFuZGxlRGVidWcgfSBmcm9tIFwiLi4vY29tbWFuZHMtZGVidWcudHNcIjtcbmltcG9ydCB7XG4gIGNyZWF0ZURlYnVnU2Vzc2lvbixcbiAgZGVidWdTZXNzaW9uQXJ0aWZhY3RQYXRoLFxuICBkZWJ1Z1Nlc3Npb25zRGlyLFxuICBsb2FkRGVidWdTZXNzaW9uLFxuICB1cGRhdGVEZWJ1Z1Nlc3Npb24sXG59IGZyb20gXCIuLi9kZWJ1Zy1zZXNzaW9uLXN0b3JlLnRzXCI7XG5cbmludGVyZmFjZSBEaXNwYXRjaENhbGwge1xuICBwYXlsb2FkOiBhbnk7XG4gIG9wdGlvbnM6IGFueTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlTW9ja1BpV2l0aERpc3BhdGNoKCkge1xuICBjb25zdCBjYWxsczogRGlzcGF0Y2hDYWxsW10gPSBbXTtcbiAgcmV0dXJuIHtcbiAgICBjYWxscyxcbiAgICBwaToge1xuICAgICAgc2VuZE1lc3NhZ2UocGF5bG9hZDogYW55LCBvcHRpb25zOiBhbnkpIHtcbiAgICAgICAgY2FsbHMucHVzaCh7IHBheWxvYWQsIG9wdGlvbnMgfSk7XG4gICAgICB9LFxuICAgIH0sXG4gIH07XG59XG5cbmludGVyZmFjZSBNb2NrQ3R4IHtcbiAgbm90aWZpY2F0aW9uczogQXJyYXk8eyBtZXNzYWdlOiBzdHJpbmc7IGxldmVsOiBzdHJpbmcgfT47XG4gIHVpOiB7XG4gICAgbm90aWZ5OiAobWVzc2FnZTogc3RyaW5nLCBsZXZlbDogc3RyaW5nKSA9PiB2b2lkO1xuICAgIGN1c3RvbTogKCkgPT4gUHJvbWlzZTx2b2lkPjtcbiAgfTtcbiAgc2h1dGRvd246ICgpID0+IFByb21pc2U8dm9pZD47XG59XG5cbmZ1bmN0aW9uIG1ha2VCYXNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1kZWJ1Zy1saWZlY3ljbGUtaW50LVwiKSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVNb2NrQ3R4KCk6IE1vY2tDdHgge1xuICBjb25zdCBub3RpZmljYXRpb25zOiBBcnJheTx7IG1lc3NhZ2U6IHN0cmluZzsgbGV2ZWw6IHN0cmluZyB9PiA9IFtdO1xuICByZXR1cm4ge1xuICAgIG5vdGlmaWNhdGlvbnMsXG4gICAgdWk6IHtcbiAgICAgIG5vdGlmeShtZXNzYWdlOiBzdHJpbmcsIGxldmVsOiBzdHJpbmcpIHtcbiAgICAgICAgbm90aWZpY2F0aW9ucy5wdXNoKHsgbWVzc2FnZSwgbGV2ZWwgfSk7XG4gICAgICB9LFxuICAgICAgY3VzdG9tOiBhc3luYyAoKSA9PiB7fSxcbiAgICB9LFxuICAgIHNodXRkb3duOiBhc3luYyAoKSA9PiB7fSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbGFzdE5vdGlmaWNhdGlvbihjdHg6IE1vY2tDdHgpOiB7IG1lc3NhZ2U6IHN0cmluZzsgbGV2ZWw6IHN0cmluZyB9IHtcbiAgYXNzZXJ0Lm9rKGN0eC5ub3RpZmljYXRpb25zLmxlbmd0aCA+IDAsIFwiZXhwZWN0ZWQgYXQgbGVhc3Qgb25lIFVJIG5vdGlmaWNhdGlvblwiKTtcbiAgcmV0dXJuIGN0eC5ub3RpZmljYXRpb25zLmF0KC0xKSE7XG59XG5cbnRlc3QoXCIvZ3NkIGRlYnVnIGxpZmVjeWNsZSBpbnRlZ3JhdGlvbiBjb3ZlcnMgc3RhcnQvbGlzdC9zdGF0dXMvY29udGludWUgYWNyb3NzIG11bHRpcGxlIHNlc3Npb25zXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIGNvbnN0IHNhdmVkID0gcHJvY2Vzcy5jd2QoKTtcbiAgcHJvY2Vzcy5jaGRpcihiYXNlKTtcblxuICB0cnkge1xuICAgIGNvbnN0IGN0eCA9IGNyZWF0ZU1vY2tDdHgoKTtcblxuICAgIGF3YWl0IGhhbmRsZUdTRENvbW1hbmQoXCJkZWJ1ZyBBUEkgcmV0dXJucyA1MDAgb24gY2hlY2tvdXRcIiwgY3R4IGFzIGFueSwge30gYXMgYW55KTtcbiAgICBjb25zdCBmaXJzdFN0YXJ0ZWQgPSBsYXN0Tm90aWZpY2F0aW9uKGN0eCk7XG4gICAgYXNzZXJ0LmVxdWFsKGZpcnN0U3RhcnRlZC5sZXZlbCwgXCJpbmZvXCIpO1xuICAgIGFzc2VydC5tYXRjaChmaXJzdFN0YXJ0ZWQubWVzc2FnZSwgL0RlYnVnIHNlc3Npb24gc3RhcnRlZDogYXBpLXJldHVybnMtNTAwLW9uLWNoZWNrb3V0Lyk7XG5cbiAgICBhd2FpdCBoYW5kbGVHU0RDb21tYW5kKFwiZGVidWcgQVBJIHJldHVybnMgNTAwIG9uIGNoZWNrb3V0XCIsIGN0eCBhcyBhbnksIHt9IGFzIGFueSk7XG4gICAgY29uc3Qgc2Vjb25kU3RhcnRlZCA9IGxhc3ROb3RpZmljYXRpb24oY3R4KTtcbiAgICBhc3NlcnQuZXF1YWwoc2Vjb25kU3RhcnRlZC5sZXZlbCwgXCJpbmZvXCIpO1xuICAgIGFzc2VydC5tYXRjaChzZWNvbmRTdGFydGVkLm1lc3NhZ2UsIC9EZWJ1ZyBzZXNzaW9uIHN0YXJ0ZWQ6IGFwaS1yZXR1cm5zLTUwMC1vbi1jaGVja291dC0yLyk7XG5cbiAgICBhd2FpdCBoYW5kbGVHU0RDb21tYW5kKFwiZGVidWcgQ2hlY2tvdXQgcmV0cmllcyBzcGluIGZvcmV2ZXJcIiwgY3R4IGFzIGFueSwge30gYXMgYW55KTtcbiAgICBjb25zdCB0aGlyZFN0YXJ0ZWQgPSBsYXN0Tm90aWZpY2F0aW9uKGN0eCk7XG4gICAgYXNzZXJ0LmVxdWFsKHRoaXJkU3RhcnRlZC5sZXZlbCwgXCJpbmZvXCIpO1xuICAgIGFzc2VydC5tYXRjaCh0aGlyZFN0YXJ0ZWQubWVzc2FnZSwgL0RlYnVnIHNlc3Npb24gc3RhcnRlZDogY2hlY2tvdXQtcmV0cmllcy1zcGluLWZvcmV2ZXIvKTtcblxuICAgIGNvbnN0IHNlc3Npb25zRGlyID0gZGVidWdTZXNzaW9uc0RpcihiYXNlKTtcbiAgICBjb25zdCBhcnRpZmFjdHMgPSByZWFkZGlyU3luYyhzZXNzaW9uc0RpcikuZmlsdGVyKG5hbWUgPT4gbmFtZS5lbmRzV2l0aChcIi5qc29uXCIpKS5zb3J0KCk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChhcnRpZmFjdHMsIFtcbiAgICAgIFwiYXBpLXJldHVybnMtNTAwLW9uLWNoZWNrb3V0LTIuanNvblwiLFxuICAgICAgXCJhcGktcmV0dXJucy01MDAtb24tY2hlY2tvdXQuanNvblwiLFxuICAgICAgXCJjaGVja291dC1yZXRyaWVzLXNwaW4tZm9yZXZlci5qc29uXCIsXG4gICAgXSk7XG5cbiAgICBhd2FpdCBoYW5kbGVHU0RDb21tYW5kKFwiZGVidWcgbGlzdFwiLCBjdHggYXMgYW55LCB7fSBhcyBhbnkpO1xuICAgIGNvbnN0IGxpc3RlZCA9IGxhc3ROb3RpZmljYXRpb24oY3R4KTtcbiAgICBhc3NlcnQuZXF1YWwobGlzdGVkLmxldmVsLCBcImluZm9cIik7XG4gICAgYXNzZXJ0Lm1hdGNoKGxpc3RlZC5tZXNzYWdlLCAvRGVidWcgc2Vzc2lvbnM6Lyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGxpc3RlZC5tZXNzYWdlLCAvYXBpLXJldHVybnMtNTAwLW9uLWNoZWNrb3V0Lyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGxpc3RlZC5tZXNzYWdlLCAvYXBpLXJldHVybnMtNTAwLW9uLWNoZWNrb3V0LTIvKTtcbiAgICBhc3NlcnQubWF0Y2gobGlzdGVkLm1lc3NhZ2UsIC9jaGVja291dC1yZXRyaWVzLXNwaW4tZm9yZXZlci8pO1xuICAgIGFzc2VydC5tYXRjaChsaXN0ZWQubWVzc2FnZSwgL21vZGU9ZGVidWcgc3RhdHVzPWFjdGl2ZSBwaGFzZT1xdWV1ZWQvKTtcblxuICAgIGF3YWl0IGhhbmRsZUdTRENvbW1hbmQoXCJkZWJ1ZyBzdGF0dXMgYXBpLXJldHVybnMtNTAwLW9uLWNoZWNrb3V0XCIsIGN0eCBhcyBhbnksIHt9IGFzIGFueSk7XG4gICAgY29uc3Qgc3RhdHVzQmVmb3JlQ29udGludWUgPSBsYXN0Tm90aWZpY2F0aW9uKGN0eCk7XG4gICAgYXNzZXJ0LmVxdWFsKHN0YXR1c0JlZm9yZUNvbnRpbnVlLmxldmVsLCBcImluZm9cIik7XG4gICAgYXNzZXJ0Lm1hdGNoKHN0YXR1c0JlZm9yZUNvbnRpbnVlLm1lc3NhZ2UsIC9eRGVidWcgc2Vzc2lvbiBzdGF0dXM6IGFwaS1yZXR1cm5zLTUwMC1vbi1jaGVja291dC9tKTtcbiAgICBhc3NlcnQubWF0Y2goc3RhdHVzQmVmb3JlQ29udGludWUubWVzc2FnZSwgL15tb2RlPWRlYnVnJC9tKTtcbiAgICBhc3NlcnQubWF0Y2goc3RhdHVzQmVmb3JlQ29udGludWUubWVzc2FnZSwgL15zdGF0dXM9YWN0aXZlJC9tKTtcbiAgICBhc3NlcnQubWF0Y2goc3RhdHVzQmVmb3JlQ29udGludWUubWVzc2FnZSwgL15waGFzZT1xdWV1ZWQkL20pO1xuICAgIGFzc2VydC5tYXRjaChzdGF0dXNCZWZvcmVDb250aW51ZS5tZXNzYWdlLCAvXnVwZGF0ZWQ9XFxkezR9LVxcZHsyfS1cXGR7Mn1UL20pO1xuXG4gICAgYXdhaXQgaGFuZGxlR1NEQ29tbWFuZChcImRlYnVnIGNvbnRpbnVlIGFwaS1yZXR1cm5zLTUwMC1vbi1jaGVja291dC0yXCIsIGN0eCBhcyBhbnksIHt9IGFzIGFueSk7XG4gICAgY29uc3QgcmVzdW1lZCA9IGxhc3ROb3RpZmljYXRpb24oY3R4KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdW1lZC5sZXZlbCwgXCJpbmZvXCIpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bWVkLm1lc3NhZ2UsIC9SZXN1bWVkIGRlYnVnIHNlc3Npb246IGFwaS1yZXR1cm5zLTUwMC1vbi1jaGVja291dC0yLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VtZWQubWVzc2FnZSwgL3N0YXR1cz1hY3RpdmUvKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdW1lZC5tZXNzYWdlLCAvcGhhc2U9Y29udGludWVkLyk7XG5cbiAgICBhd2FpdCBoYW5kbGVHU0RDb21tYW5kKFwiZGVidWcgc3RhdHVzIGFwaS1yZXR1cm5zLTUwMC1vbi1jaGVja291dC0yXCIsIGN0eCBhcyBhbnksIHt9IGFzIGFueSk7XG4gICAgY29uc3Qgc3RhdHVzQWZ0ZXJDb250aW51ZSA9IGxhc3ROb3RpZmljYXRpb24oY3R4KTtcbiAgICBhc3NlcnQuZXF1YWwoc3RhdHVzQWZ0ZXJDb250aW51ZS5sZXZlbCwgXCJpbmZvXCIpO1xuICAgIGFzc2VydC5tYXRjaChzdGF0dXNBZnRlckNvbnRpbnVlLm1lc3NhZ2UsIC9ecGhhc2U9Y29udGludWVkJC9tKTtcbiAgICBhc3NlcnQubWF0Y2goc3RhdHVzQWZ0ZXJDb250aW51ZS5tZXNzYWdlLCAvXnVwZGF0ZWQ9XFxkezR9LVxcZHsyfS1cXGR7Mn1UL20pO1xuICB9IGZpbmFsbHkge1xuICAgIHByb2Nlc3MuY2hkaXIoc2F2ZWQpO1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiL2dzZCBkZWJ1ZyBsaWZlY3ljbGUgaW50ZWdyYXRpb24gaGFuZGxlcyBpbnZhbGlkIHNsdWdzIGFuZCBtYWxmb3JtZWQgYXJ0aWZhY3RzIHdpdGggYWN0aW9uYWJsZSBkaWFnbm9zdGljc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICBjb25zdCBzYXZlZCA9IHByb2Nlc3MuY3dkKCk7XG4gIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjdHggPSBjcmVhdGVNb2NrQ3R4KCk7XG5cbiAgICBhd2FpdCBoYW5kbGVHU0RDb21tYW5kKFwiZGVidWcgU3luYyBidWcgaW4gY2hlY2tvdXRcIiwgY3R4IGFzIGFueSwge30gYXMgYW55KTtcbiAgICBjb25zdCBzdGFydGVkID0gbGFzdE5vdGlmaWNhdGlvbihjdHgpO1xuICAgIGFzc2VydC5lcXVhbChzdGFydGVkLmxldmVsLCBcImluZm9cIik7XG4gICAgYXNzZXJ0Lm1hdGNoKHN0YXJ0ZWQubWVzc2FnZSwgL0RlYnVnIHNlc3Npb24gc3RhcnRlZDogc3luYy1idWctaW4tY2hlY2tvdXQvKTtcblxuICAgIGF3YWl0IGhhbmRsZUdTRENvbW1hbmQoXCJkZWJ1ZyBzdGF0dXMgbm8tc3VjaC1zZXNzaW9uXCIsIGN0eCBhcyBhbnksIHt9IGFzIGFueSk7XG4gICAgY29uc3QgbWlzc2luZ1N0YXR1cyA9IGxhc3ROb3RpZmljYXRpb24oY3R4KTtcbiAgICBhc3NlcnQuZXF1YWwobWlzc2luZ1N0YXR1cy5sZXZlbCwgXCJ3YXJuaW5nXCIpO1xuICAgIGFzc2VydC5tYXRjaChtaXNzaW5nU3RhdHVzLm1lc3NhZ2UsIC9Vbmtub3duIGRlYnVnIHNlc3Npb24gc2x1ZyAnbm8tc3VjaC1zZXNzaW9uJy8pO1xuICAgIGFzc2VydC5tYXRjaChtaXNzaW5nU3RhdHVzLm1lc3NhZ2UsIC9SdW4gXFwvZ3NkIGRlYnVnIGxpc3QvKTtcblxuICAgIGF3YWl0IGhhbmRsZUdTRENvbW1hbmQoXCJkZWJ1ZyBjb250aW51ZSBuby1zdWNoLXNlc3Npb25cIiwgY3R4IGFzIGFueSwge30gYXMgYW55KTtcbiAgICBjb25zdCBtaXNzaW5nQ29udGludWUgPSBsYXN0Tm90aWZpY2F0aW9uKGN0eCk7XG4gICAgYXNzZXJ0LmVxdWFsKG1pc3NpbmdDb250aW51ZS5sZXZlbCwgXCJ3YXJuaW5nXCIpO1xuICAgIGFzc2VydC5tYXRjaChtaXNzaW5nQ29udGludWUubWVzc2FnZSwgL1Vua25vd24gZGVidWcgc2Vzc2lvbiBzbHVnICduby1zdWNoLXNlc3Npb24nLyk7XG5cbiAgICBjb25zdCBicm9rZW5BcnRpZmFjdFBhdGggPSBkZWJ1Z1Nlc3Npb25BcnRpZmFjdFBhdGgoYmFzZSwgXCJicm9rZW4tc2Vzc2lvblwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGJyb2tlbkFydGlmYWN0UGF0aCwgXCJ7IGRlZmluaXRlbHktbm90LXZhbGlkLWpzb25cIiwgXCJ1dGYtOFwiKTtcblxuICAgIGF3YWl0IGhhbmRsZUdTRENvbW1hbmQoXCJkZWJ1ZyBzdGF0dXMgYnJva2VuLXNlc3Npb25cIiwgY3R4IGFzIGFueSwge30gYXMgYW55KTtcbiAgICBjb25zdCBjb3JydXB0ZWRTdGF0dXMgPSBsYXN0Tm90aWZpY2F0aW9uKGN0eCk7XG4gICAgYXNzZXJ0LmVxdWFsKGNvcnJ1cHRlZFN0YXR1cy5sZXZlbCwgXCJ3YXJuaW5nXCIpO1xuICAgIGFzc2VydC5tYXRjaChjb3JydXB0ZWRTdGF0dXMubWVzc2FnZSwgL1VuYWJsZSB0byBsb2FkIGRlYnVnIHNlc3Npb24gJ2Jyb2tlbi1zZXNzaW9uJy8pO1xuICAgIGFzc2VydC5tYXRjaChjb3JydXB0ZWRTdGF0dXMubWVzc2FnZSwgL1RyeSBcXC9nc2QgZGVidWcgLS1kaWFnbm9zZSBicm9rZW4tc2Vzc2lvbi8pO1xuXG4gICAgYXdhaXQgaGFuZGxlR1NEQ29tbWFuZChcImRlYnVnIGxpc3RcIiwgY3R4IGFzIGFueSwge30gYXMgYW55KTtcbiAgICBjb25zdCBsaXN0ZWQgPSBsYXN0Tm90aWZpY2F0aW9uKGN0eCk7XG4gICAgYXNzZXJ0LmVxdWFsKGxpc3RlZC5sZXZlbCwgXCJpbmZvXCIpO1xuICAgIGFzc2VydC5tYXRjaChsaXN0ZWQubWVzc2FnZSwgL01hbGZvcm1lZCBhcnRpZmFjdHM6IDEvKTtcbiAgICBhc3NlcnQubWF0Y2gobGlzdGVkLm1lc3NhZ2UsIC9icm9rZW4tc2Vzc2lvblxcLmpzb24vKTtcbiAgICBhc3NlcnQubWF0Y2gobGlzdGVkLm1lc3NhZ2UsIC9SdW4gXFwvZ3NkIGRlYnVnIC0tZGlhZ25vc2UgZm9yIHJlbWVkaWF0aW9uIGd1aWRhbmNlLyk7XG5cbiAgICBhd2FpdCBoYW5kbGVHU0RDb21tYW5kKFwiZGVidWcgLS1kaWFnbm9zZVwiLCBjdHggYXMgYW55LCB7fSBhcyBhbnkpO1xuICAgIGNvbnN0IGRpYWdub3NlZCA9IGxhc3ROb3RpZmljYXRpb24oY3R4KTtcbiAgICBhc3NlcnQuZXF1YWwoZGlhZ25vc2VkLmxldmVsLCBcIndhcm5pbmdcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKGRpYWdub3NlZC5tZXNzYWdlLCAvRGVidWcgc2Vzc2lvbiBkaWFnbm9zdGljczovKTtcbiAgICBhc3NlcnQubWF0Y2goZGlhZ25vc2VkLm1lc3NhZ2UsIC9tYWxmb3JtZWRBcnRpZmFjdHM9MS8pO1xuICAgIGFzc2VydC5tYXRjaChkaWFnbm9zZWQubWVzc2FnZSwgL1JlbWVkaWF0aW9uOiByZXBhaXJcXC9yZW1vdmUgbWFsZm9ybWVkIEpTT04gYXJ0aWZhY3RzIHVuZGVyIFxcLmdzZFxcL2RlYnVnXFwvc2Vzc2lvbnNcXC8vKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBwcm9jZXNzLmNoZGlyKHNhdmVkKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcIi9nc2QgZGVidWcgbGlmZWN5Y2xlIGludGVncmF0aW9uIGtlZXBzIHNlc3Npb24gYXJ0aWZhY3RzIGlzb2xhdGVkIGZyb20gZGVidWcgbG9ncyBhbmQgcHJlc2VydmVzIHNsdWcgZGV0ZXJtaW5pc21cIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmN3ZCgpO1xuICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuXG4gICAgY29uc3QgZGVidWdEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcImRlYnVnXCIpO1xuICAgIG1rZGlyU3luYyhkZWJ1Z0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRlYnVnRGlyLCBcInBheW1lbnQtdGltZW91dC5sb2dcIiksIFwibG9nIHNlZWRcXG5cIiwgXCJ1dGYtOFwiKTtcblxuICAgIGF3YWl0IGhhbmRsZUdTRENvbW1hbmQoXCJkZWJ1ZyBQYXltZW50IHRpbWVvdXRcIiwgY3R4IGFzIGFueSwge30gYXMgYW55KTtcbiAgICBjb25zdCBmaXJzdFN0YXJ0ZWQgPSBsYXN0Tm90aWZpY2F0aW9uKGN0eCk7XG4gICAgYXNzZXJ0LmVxdWFsKGZpcnN0U3RhcnRlZC5sZXZlbCwgXCJpbmZvXCIpO1xuICAgIGFzc2VydC5tYXRjaChmaXJzdFN0YXJ0ZWQubWVzc2FnZSwgL0RlYnVnIHNlc3Npb24gc3RhcnRlZDogcGF5bWVudC10aW1lb3V0Lyk7XG5cbiAgICAvLyBFeGlzdGluZyAubG9nIGZpbGVzIG11c3Qgbm90IHJlc2VydmUgc2x1ZyBzdWZmaXhlcyBmb3Igc2Vzc2lvbiBhcnRpZmFjdHMuXG4gICAgYXdhaXQgaGFuZGxlR1NEQ29tbWFuZChcImRlYnVnIFBheW1lbnQgdGltZW91dFwiLCBjdHggYXMgYW55LCB7fSBhcyBhbnkpO1xuICAgIGNvbnN0IHNlY29uZFN0YXJ0ZWQgPSBsYXN0Tm90aWZpY2F0aW9uKGN0eCk7XG4gICAgYXNzZXJ0LmVxdWFsKHNlY29uZFN0YXJ0ZWQubGV2ZWwsIFwiaW5mb1wiKTtcbiAgICBhc3NlcnQubWF0Y2goc2Vjb25kU3RhcnRlZC5tZXNzYWdlLCAvRGVidWcgc2Vzc2lvbiBzdGFydGVkOiBwYXltZW50LXRpbWVvdXQtMi8pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKGV4aXN0c1N5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJkZWJ1Z1wiLCBcInBheW1lbnQtdGltZW91dC5qc29uXCIpKSwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChleGlzdHNTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZGVidWdcIiwgXCJzZXNzaW9uc1wiLCBcInBheW1lbnQtdGltZW91dC5qc29uXCIpKSwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGV4aXN0c1N5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJkZWJ1Z1wiLCBcInNlc3Npb25zXCIsIFwicGF5bWVudC10aW1lb3V0LTIuanNvblwiKSksIHRydWUpO1xuXG4gICAgYXdhaXQgaGFuZGxlR1NEQ29tbWFuZChcImxvZ3MgZGVidWdcIiwgY3R4IGFzIGFueSwge30gYXMgYW55KTtcbiAgICBjb25zdCBsb2dzTGlzdGVkID0gbGFzdE5vdGlmaWNhdGlvbihjdHgpO1xuICAgIGFzc2VydC5lcXVhbChsb2dzTGlzdGVkLmxldmVsLCBcImluZm9cIik7XG4gICAgYXNzZXJ0Lm1hdGNoKGxvZ3NMaXN0ZWQubWVzc2FnZSwgL0RlYnVnIExvZ3MgXFwoXFwuZ3NkXFwvZGVidWdcXC9cXCk6Lyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGxvZ3NMaXN0ZWQubWVzc2FnZSwgL3BheW1lbnQtdGltZW91dFxcLmxvZy8pO1xuICAgIGFzc2VydC5kb2VzTm90TWF0Y2gobG9nc0xpc3RlZC5tZXNzYWdlLCAvcGF5bWVudC10aW1lb3V0XFwuanNvbi8pO1xuXG4gICAgYXdhaXQgaGFuZGxlR1NEQ29tbWFuZChcImRlYnVnIGxpc3RcIiwgY3R4IGFzIGFueSwge30gYXMgYW55KTtcbiAgICBjb25zdCBzZXNzaW9uc0xpc3RlZCA9IGxhc3ROb3RpZmljYXRpb24oY3R4KTtcbiAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbnNMaXN0ZWQubGV2ZWwsIFwiaW5mb1wiKTtcbiAgICBhc3NlcnQubWF0Y2goc2Vzc2lvbnNMaXN0ZWQubWVzc2FnZSwgL3BheW1lbnQtdGltZW91dC8pO1xuICAgIGFzc2VydC5tYXRjaChzZXNzaW9uc0xpc3RlZC5tZXNzYWdlLCAvcGF5bWVudC10aW1lb3V0LTIvKTtcbiAgICBhc3NlcnQubWF0Y2goc2Vzc2lvbnNMaXN0ZWQubWVzc2FnZSwgL21vZGU9ZGVidWcgc3RhdHVzPWFjdGl2ZSBwaGFzZT1xdWV1ZWQvKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBwcm9jZXNzLmNoZGlyKHNhdmVkKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcIi9nc2QgZGVidWcgLS1kaWFnbm9zZSA8aXNzdWU+IGRpc3BhdGNoZXMgZmluZF9yb290X2NhdXNlX29ubHkgZ29hbCBhbmQgcmVjb3JkcyBtb2RlPWRpYWdub3NlIHNlc3Npb25cIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmN3ZCgpO1xuICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuICAgIGNvbnN0IHsgY2FsbHMsIHBpIH0gPSBjcmVhdGVNb2NrUGlXaXRoRGlzcGF0Y2goKTtcblxuICAgIGF3YWl0IGhhbmRsZURlYnVnKFwiLS1kaWFnbm9zZSBhdXRoIHRva2VuIHJvdGF0aW9uIGJyZWFrcyBzZXNzaW9uc1wiLCBjdHggYXMgYW55LCBwaSBhcyBhbnkpO1xuXG4gICAgY29uc3QgbiA9IGxhc3ROb3RpZmljYXRpb24oY3R4KTtcbiAgICBhc3NlcnQuZXF1YWwobi5sZXZlbCwgXCJpbmZvXCIpO1xuICAgIGFzc2VydC5tYXRjaChuLm1lc3NhZ2UsIC9EaWFnbm9zZSBzZXNzaW9uIHN0YXJ0ZWQ6Lyk7XG4gICAgYXNzZXJ0Lm1hdGNoKG4ubWVzc2FnZSwgL21vZGU9ZGlhZ25vc2UvKTtcbiAgICBhc3NlcnQubWF0Y2gobi5tZXNzYWdlLCAvZGlzcGF0Y2hNb2RlPWZpbmRfcm9vdF9jYXVzZV9vbmx5Lyk7XG5cbiAgICBhc3NlcnQuZXF1YWwoY2FsbHMubGVuZ3RoLCAxLCBcInNob3VsZCBkaXNwYXRjaCBleGFjdGx5IG9uZSBtZXNzYWdlXCIpO1xuICAgIGNvbnN0IGNhbGwgPSBjYWxsc1swXTtcbiAgICBhc3NlcnQuZXF1YWwoY2FsbC5wYXlsb2FkLmN1c3RvbVR5cGUsIFwiZ3NkLWRlYnVnLWRpYWdub3NlXCIpO1xuICAgIGFzc2VydC5tYXRjaChjYWxsLnBheWxvYWQuY29udGVudCwgL2ZpbmRfcm9vdF9jYXVzZV9vbmx5Lyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGNhbGwucGF5bG9hZC5jb250ZW50LCAvYXV0aCB0b2tlbiByb3RhdGlvbiBicmVha3Mgc2Vzc2lvbnMvaSk7XG4gICAgYXNzZXJ0LmVxdWFsKGNhbGwub3B0aW9ucy50cmlnZ2VyVHVybiwgdHJ1ZSk7XG4gIH0gZmluYWxseSB7XG4gICAgcHJvY2Vzcy5jaGRpcihzYXZlZCk7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCIvZ3NkIGRlYnVnIGNvbnRpbnVlIDxzbHVnPiBkaXNwYXRjaGVzIGZpbmRfYW5kX2ZpeCBnb2FsIHNjb3BlZCB0byB0YXJnZXQgc2x1Z1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICBjb25zdCBzYXZlZCA9IHByb2Nlc3MuY3dkKCk7XG4gIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjdHggPSBjcmVhdGVNb2NrQ3R4KCk7XG4gICAgY29uc3QgeyBjYWxscywgcGkgfSA9IGNyZWF0ZU1vY2tQaVdpdGhEaXNwYXRjaCgpO1xuXG4gICAgLy8gU3RhcnQgdHdvIHNlc3Npb25zIHNvIHdlIGNhbiB2ZXJpZnkgY29udGludWUgdGFyZ2V0cyBvbmx5IHRoZSByaWdodCBvbmUuXG4gICAgYXdhaXQgaGFuZGxlRGVidWcoXCJSYWNlIGNvbmRpdGlvbiBpbiBwYXltZW50IGhhbmRsZXJcIiwgY3R4IGFzIGFueSwge30gYXMgYW55KTtcbiAgICBhd2FpdCBoYW5kbGVEZWJ1ZyhcIlN0YWxlIGNhY2hlIG9uIGNoZWNrb3V0XCIsIGN0eCBhcyBhbnksIHt9IGFzIGFueSk7XG5cbiAgICBjYWxscy5sZW5ndGggPSAwOyAvLyByZXNldCBcdTIwMTQgb25seSBjcmVhdGVkIHdpdGhvdXQgcGkgZGlzcGF0Y2ggYWJvdmVcblxuICAgIGF3YWl0IGhhbmRsZURlYnVnKFwiY29udGludWUgcmFjZS1jb25kaXRpb24taW4tcGF5bWVudC1oYW5kbGVyXCIsIGN0eCBhcyBhbnksIHBpIGFzIGFueSk7XG5cbiAgICBjb25zdCBuID0gbGFzdE5vdGlmaWNhdGlvbihjdHgpO1xuICAgIGFzc2VydC5lcXVhbChuLmxldmVsLCBcImluZm9cIik7XG4gICAgYXNzZXJ0Lm1hdGNoKG4ubWVzc2FnZSwgL1Jlc3VtZWQgZGVidWcgc2Vzc2lvbjogcmFjZS1jb25kaXRpb24taW4tcGF5bWVudC1oYW5kbGVyLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKG4ubWVzc2FnZSwgL3BoYXNlPWNvbnRpbnVlZC8pO1xuICAgIGFzc2VydC5tYXRjaChuLm1lc3NhZ2UsIC9kaXNwYXRjaE1vZGU9ZmluZF9hbmRfZml4Lyk7XG5cbiAgICBhc3NlcnQuZXF1YWwoY2FsbHMubGVuZ3RoLCAxLCBcInNob3VsZCBkaXNwYXRjaCBleGFjdGx5IG9uZSBtZXNzYWdlXCIpO1xuICAgIGNvbnN0IGNhbGwgPSBjYWxsc1swXTtcbiAgICBhc3NlcnQuZXF1YWwoY2FsbC5wYXlsb2FkLmN1c3RvbVR5cGUsIFwiZ3NkLWRlYnVnLWNvbnRpbnVlXCIpO1xuICAgIGFzc2VydC5tYXRjaChjYWxsLnBheWxvYWQuY29udGVudCwgL2ZpbmRfYW5kX2ZpeC8pO1xuICAgIC8vIENvbnRlbnQgbXVzdCByZWZlcmVuY2UgdGhlIHRhcmdldCBzbHVnLCBub3QgdGhlIG90aGVyIHNlc3Npb24uXG4gICAgYXNzZXJ0Lm1hdGNoKGNhbGwucGF5bG9hZC5jb250ZW50LCAvcmFjZS1jb25kaXRpb24taW4tcGF5bWVudC1oYW5kbGVyLyk7XG4gICAgYXNzZXJ0LmRvZXNOb3RNYXRjaChjYWxsLnBheWxvYWQuY29udGVudCwgL3N0YWxlLWNhY2hlLW9uLWNoZWNrb3V0Lyk7XG4gICAgYXNzZXJ0LmVxdWFsKGNhbGwub3B0aW9ucy50cmlnZ2VyVHVybiwgdHJ1ZSk7XG4gIH0gZmluYWxseSB7XG4gICAgcHJvY2Vzcy5jaGRpcihzYXZlZCk7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCIvZ3NkIGRlYnVnIC0tZGlhZ25vc2UgKHplcm8tYXJnKSB3aXRoIG5vIHBpIHN0aWxsIHJlcG9ydHMgbWFsZm9ybWVkIGFydGlmYWN0IGNvdW50cyB3aXRob3V0IGRpc3BhdGNoXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIGNvbnN0IHNhdmVkID0gcHJvY2Vzcy5jd2QoKTtcbiAgcHJvY2Vzcy5jaGRpcihiYXNlKTtcblxuICB0cnkge1xuICAgIGNvbnN0IGN0eCA9IGNyZWF0ZU1vY2tDdHgoKTtcbiAgICBjb25zdCB7IGNhbGxzLCBwaSB9ID0gY3JlYXRlTW9ja1BpV2l0aERpc3BhdGNoKCk7XG5cbiAgICAvLyBJbmplY3QgdHdvIGJyb2tlbiBhcnRpZmFjdHMuXG4gICAgY29uc3Qgc2Vzc2lvbnNEaXIgPSBkZWJ1Z1Nlc3Npb25zRGlyKGJhc2UpO1xuICAgIG1rZGlyU3luYyhzZXNzaW9uc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHNlc3Npb25zRGlyLCBcImJyb2tlbi1hLmpzb25cIiksIFwie2JhZCBqc29uXCIsIFwidXRmLThcIik7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHNlc3Npb25zRGlyLCBcImJyb2tlbi1iLmpzb25cIiksIFwibnVsbFwiLCBcInV0Zi04XCIpO1xuXG4gICAgLy8gWmVyby1hcmcgLS1kaWFnbm9zZSB2aWEgZGlzcGF0Y2hlciAobm8gcGkpIFx1MjAxNCBkaXNwYXRjaCBzaG91bGQgTk9UIGZpcmUuXG4gICAgYXdhaXQgaGFuZGxlR1NEQ29tbWFuZChcImRlYnVnIC0tZGlhZ25vc2VcIiwgY3R4IGFzIGFueSwge30gYXMgYW55KTtcblxuICAgIGNvbnN0IG4gPSBsYXN0Tm90aWZpY2F0aW9uKGN0eCk7XG4gICAgYXNzZXJ0LmVxdWFsKG4ubGV2ZWwsIFwid2FybmluZ1wiKTtcbiAgICBhc3NlcnQubWF0Y2gobi5tZXNzYWdlLCAvRGVidWcgc2Vzc2lvbiBkaWFnbm9zdGljczovKTtcbiAgICBhc3NlcnQubWF0Y2gobi5tZXNzYWdlLCAvbWFsZm9ybWVkQXJ0aWZhY3RzPTIvKTtcbiAgICBhc3NlcnQubWF0Y2gobi5tZXNzYWdlLCAvUmVtZWRpYXRpb246Lyk7XG5cbiAgICAvLyBOb3cgY29uZmlybSBubyBkaXNwYXRjaCBvY2N1cnJlZCBldmVuIHdpdGggcGkgcHJlc2VudCAoemVyby1hcmcgZGlhZ25vc2UgaXMgYWR2aXNvcnkgb25seSkuXG4gICAgYXdhaXQgaGFuZGxlRGVidWcoXCItLWRpYWdub3NlXCIsIGN0eCBhcyBhbnksIHBpIGFzIGFueSk7XG4gICAgYXNzZXJ0LmVxdWFsKGNhbGxzLmxlbmd0aCwgMCwgXCJ6ZXJvLWFyZyAtLWRpYWdub3NlIG11c3Qgbm90IGRpc3BhdGNoIGV2ZW4gd2l0aCBwaSBwcmVzZW50XCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHByb2Nlc3MuY2hkaXIoc2F2ZWQpO1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiL2dzZCBkZWJ1ZyBuZWdhdGl2ZTogY29udGludWUgdW5rbm93biBzbHVnIGVtaXRzIHdhcm5pbmcsIGNvbnRpbnVlIHJlc29sdmVkIHNlc3Npb24gZW1pdHMgd2FybmluZ1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICBjb25zdCBzYXZlZCA9IHByb2Nlc3MuY3dkKCk7XG4gIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjdHggPSBjcmVhdGVNb2NrQ3R4KCk7XG4gICAgY29uc3QgeyBjYWxscywgcGkgfSA9IGNyZWF0ZU1vY2tQaVdpdGhEaXNwYXRjaCgpO1xuXG4gICAgLy8gQ29udGludWUgb24gbm9uLWV4aXN0ZW50IHNsdWcuXG4gICAgYXdhaXQgaGFuZGxlRGVidWcoXCJjb250aW51ZSB0b3RhbGx5LW5vbmV4aXN0ZW50LXNsdWdcIiwgY3R4IGFzIGFueSwgcGkgYXMgYW55KTtcbiAgICBjb25zdCBub3RGb3VuZCA9IGxhc3ROb3RpZmljYXRpb24oY3R4KTtcbiAgICBhc3NlcnQuZXF1YWwobm90Rm91bmQubGV2ZWwsIFwid2FybmluZ1wiKTtcbiAgICBhc3NlcnQubWF0Y2gobm90Rm91bmQubWVzc2FnZSwgL1Vua25vd24gZGVidWcgc2Vzc2lvbiBzbHVnICd0b3RhbGx5LW5vbmV4aXN0ZW50LXNsdWcnLyk7XG4gICAgYXNzZXJ0LmVxdWFsKGNhbGxzLmxlbmd0aCwgMCwgXCJubyBkaXNwYXRjaCBmb3IgdW5rbm93biBzbHVnXCIpO1xuXG4gICAgLy8gU3RhcnQgYW5kIG1hbnVhbGx5IGNoZWNrIHRoYXQgaW52YWxpZCAyLXRva2VuIHN0YXR1cyAobWlzc2luZyBzbHVnKSBlbWl0cyBlcnJvciwgbm90IHVzYWdlLlxuICAgIGF3YWl0IGhhbmRsZURlYnVnKFwic3RhdHVzXCIsIGN0eCBhcyBhbnksIHt9IGFzIGFueSk7XG4gICAgY29uc3Qgbm9TbHVnID0gbGFzdE5vdGlmaWNhdGlvbihjdHgpO1xuICAgIGFzc2VydC5lcXVhbChub1NsdWcubGV2ZWwsIFwid2FybmluZ1wiKTtcbiAgICBhc3NlcnQubWF0Y2gobm9TbHVnLm1lc3NhZ2UsIC9NaXNzaW5nIHNsdWcvKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBwcm9jZXNzLmNoZGlyKHNhdmVkKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcIi9nc2QgZGVidWcgbmVnYXRpdmU6IG11bHRpcGxlIHNlc3Npb25zIHdpdGggc2ltaWxhciBzbHVncyBcdTIwMTQgc3RhdHVzIGFuZCBjb250aW51ZSB0YXJnZXQgZXhhY3QgbWF0Y2ggb25seVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICBjb25zdCBzYXZlZCA9IHByb2Nlc3MuY3dkKCk7XG4gIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjdHggPSBjcmVhdGVNb2NrQ3R4KCk7XG5cbiAgICBhd2FpdCBoYW5kbGVHU0RDb21tYW5kKFwiZGVidWcgTG9naW4gdG9rZW4gZXhwaXJlc1wiLCBjdHggYXMgYW55LCB7fSBhcyBhbnkpO1xuICAgIGF3YWl0IGhhbmRsZUdTRENvbW1hbmQoXCJkZWJ1ZyBMb2dpbiB0b2tlbiBleHBpcmVzIHRvbyBmYXN0XCIsIGN0eCBhcyBhbnksIHt9IGFzIGFueSk7XG5cbiAgICAvLyBsaXN0IHRvIGNvbmZpcm0gdHdvIGRpc3RpbmN0IHNsdWdzIGV4aXN0LlxuICAgIGF3YWl0IGhhbmRsZUdTRENvbW1hbmQoXCJkZWJ1ZyBsaXN0XCIsIGN0eCBhcyBhbnksIHt9IGFzIGFueSk7XG4gICAgY29uc3QgbGlzdGVkID0gbGFzdE5vdGlmaWNhdGlvbihjdHgpO1xuICAgIGFzc2VydC5tYXRjaChsaXN0ZWQubWVzc2FnZSwgL2xvZ2luLXRva2VuLWV4cGlyZXNcXGIvKTtcbiAgICBhc3NlcnQubWF0Y2gobGlzdGVkLm1lc3NhZ2UsIC9sb2dpbi10b2tlbi1leHBpcmVzLXRvby1mYXN0XFxiLyk7XG5cbiAgICAvLyBzdGF0dXMgb24gYmFzZSBzbHVnIG11c3Qgbm90IGFjY2lkZW50YWxseSBkZXNjcmliZSB0aGUgc3VmZml4ZWQgb25lLlxuICAgIGF3YWl0IGhhbmRsZUdTRENvbW1hbmQoXCJkZWJ1ZyBzdGF0dXMgbG9naW4tdG9rZW4tZXhwaXJlc1wiLCBjdHggYXMgYW55LCB7fSBhcyBhbnkpO1xuICAgIGNvbnN0IGJhc2VTdGF0dXMgPSBsYXN0Tm90aWZpY2F0aW9uKGN0eCk7XG4gICAgYXNzZXJ0Lm1hdGNoKGJhc2VTdGF0dXMubWVzc2FnZSwgL15EZWJ1ZyBzZXNzaW9uIHN0YXR1czogbG9naW4tdG9rZW4tZXhwaXJlcyQvbSk7XG4gICAgYXNzZXJ0LmRvZXNOb3RNYXRjaChiYXNlU3RhdHVzLm1lc3NhZ2UsIC9sb2dpbi10b2tlbi1leHBpcmVzLXRvby1mYXN0Lyk7XG5cbiAgICAvLyBzdGF0dXMgb24gc3VmZml4ZWQgc2x1ZyBtdXN0IGRlc2NyaWJlIHRoYXQgb25lLlxuICAgIGF3YWl0IGhhbmRsZUdTRENvbW1hbmQoXCJkZWJ1ZyBzdGF0dXMgbG9naW4tdG9rZW4tZXhwaXJlcy10b28tZmFzdFwiLCBjdHggYXMgYW55LCB7fSBhcyBhbnkpO1xuICAgIGNvbnN0IHN1ZmZpeGVkU3RhdHVzID0gbGFzdE5vdGlmaWNhdGlvbihjdHgpO1xuICAgIGFzc2VydC5tYXRjaChzdWZmaXhlZFN0YXR1cy5tZXNzYWdlLCAvXkRlYnVnIHNlc3Npb24gc3RhdHVzOiBsb2dpbi10b2tlbi1leHBpcmVzLXRvby1mYXN0JC9tKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBwcm9jZXNzLmNoZGlyKHNhdmVkKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIFMwMyB0ZXN0czogY2hlY2twb2ludC9UREQgZ2F0ZSBkaXNwYXRjaCBhbmQgYmFja3dhcmQgY29tcGF0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiL2dzZCBkZWJ1ZyBTMDM6IGNoZWNrcG9pbnQgcmVzdW1lIGRpc3BhdGNoZXMgZW5yaWNoZWQgcGF5bG9hZCB2aWEgZGVidWctc2Vzc2lvbi1tYW5hZ2VyIHRlbXBsYXRlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIGNvbnN0IHNhdmVkID0gcHJvY2Vzcy5jd2QoKTtcbiAgcHJvY2Vzcy5jaGRpcihiYXNlKTtcblxuICB0cnkge1xuICAgIGNvbnN0IGN0eCA9IGNyZWF0ZU1vY2tDdHgoKTtcbiAgICBjb25zdCB7IGNhbGxzLCBwaSB9ID0gY3JlYXRlTW9ja1BpV2l0aERpc3BhdGNoKCk7XG5cbiAgICBjb25zdCBjcmVhdGVkID0gY3JlYXRlRGVidWdTZXNzaW9uKGJhc2UsIHsgaXNzdWU6IFwiTG9naW4gZmFpbHMgYWZ0ZXIgZGVwbG95XCIgfSk7XG4gICAgY29uc3Qgc2x1ZyA9IGNyZWF0ZWQuc2Vzc2lvbi5zbHVnO1xuXG4gICAgdXBkYXRlRGVidWdTZXNzaW9uKGJhc2UsIHNsdWcsIHtcbiAgICAgIGNoZWNrcG9pbnQ6IHtcbiAgICAgICAgdHlwZTogXCJodW1hbi12ZXJpZnlcIixcbiAgICAgICAgc3VtbWFyeTogXCJWZXJpZnkgZml4IG9uIHN0YWdpbmdcIixcbiAgICAgICAgYXdhaXRpbmdSZXNwb25zZTogdHJ1ZSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBhd2FpdCBoYW5kbGVEZWJ1ZyhgY29udGludWUgJHtzbHVnfWAsIGN0eCBhcyBhbnksIHBpIGFzIGFueSk7XG5cbiAgICBjb25zdCBuID0gbGFzdE5vdGlmaWNhdGlvbihjdHgpO1xuICAgIGFzc2VydC5lcXVhbChuLmxldmVsLCBcImluZm9cIik7XG4gICAgYXNzZXJ0Lm1hdGNoKG4ubWVzc2FnZSwgbmV3IFJlZ0V4cChgUmVzdW1lZCBkZWJ1ZyBzZXNzaW9uOiAke3NsdWd9YCkpO1xuICAgIGFzc2VydC5tYXRjaChuLm1lc3NhZ2UsIC9waGFzZT1jb250aW51ZWQvKTtcbiAgICBhc3NlcnQubWF0Y2gobi5tZXNzYWdlLCAvZGlzcGF0Y2hNb2RlPWNoZWNrcG9pbnRUeXBlPWh1bWFuLXZlcmlmeS8pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKGNhbGxzLmxlbmd0aCwgMSwgXCJzaG91bGQgZGlzcGF0Y2ggZXhhY3RseSBvbmUgbWVzc2FnZVwiKTtcbiAgICBjb25zdCBjYWxsID0gY2FsbHNbMF07XG4gICAgYXNzZXJ0LmVxdWFsKGNhbGwucGF5bG9hZC5jdXN0b21UeXBlLCBcImdzZC1kZWJ1Zy1jb250aW51ZVwiKTtcbiAgICAvLyBkZWJ1Zy1zZXNzaW9uLW1hbmFnZXIgdGVtcGxhdGUgbWFya2VyIChhYnNlbnQgZnJvbSBkZWJ1Zy1kaWFnbm9zZSlcbiAgICBhc3NlcnQubWF0Y2goY2FsbC5wYXlsb2FkLmNvbnRlbnQsIC9TdHJ1Y3R1cmVkIFJldHVybiBQcm90b2NvbC8pO1xuICAgIC8vIENoZWNrcG9pbnQgY29udGV4dCBlbWJlZGRlZFxuICAgIGFzc2VydC5tYXRjaChjYWxsLnBheWxvYWQuY29udGVudCwgLyMjIEFjdGl2ZSBDaGVja3BvaW50Lyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGNhbGwucGF5bG9hZC5jb250ZW50LCAvdHlwZTogaHVtYW4tdmVyaWZ5Lyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGNhbGwucGF5bG9hZC5jb250ZW50LCAvc3VtbWFyeTogVmVyaWZ5IGZpeCBvbiBzdGFnaW5nLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGNhbGwucGF5bG9hZC5jb250ZW50LCAvYXdhaXRpbmdSZXNwb25zZTogdHJ1ZS8pO1xuICAgIGFzc2VydC5lcXVhbChjYWxsLm9wdGlvbnMudHJpZ2dlclR1cm4sIHRydWUpO1xuICB9IGZpbmFsbHkge1xuICAgIHByb2Nlc3MuY2hkaXIoc2F2ZWQpO1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiL2dzZCBkZWJ1ZyBTMDM6IFRERCBnYXRlIHBlbmRpbmcgZGlzcGF0Y2hlcyBmaW5kX3Jvb3RfY2F1c2Vfb25seSB3aXRoIFRERCBpbnN0cnVjdGlvbnNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmN3ZCgpO1xuICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuICAgIGNvbnN0IHsgY2FsbHMsIHBpIH0gPSBjcmVhdGVNb2NrUGlXaXRoRGlzcGF0Y2goKTtcblxuICAgIGNvbnN0IGNyZWF0ZWQgPSBjcmVhdGVEZWJ1Z1Nlc3Npb24oYmFzZSwgeyBpc3N1ZTogXCJBdXRoIHJlZnJlc2ggcmFjZXMgb24gbW9iaWxlXCIgfSk7XG4gICAgY29uc3Qgc2x1ZyA9IGNyZWF0ZWQuc2Vzc2lvbi5zbHVnO1xuXG4gICAgdXBkYXRlRGVidWdTZXNzaW9uKGJhc2UsIHNsdWcsIHtcbiAgICAgIHRkZEdhdGU6IHsgZW5hYmxlZDogdHJ1ZSwgcGhhc2U6IFwicGVuZGluZ1wiIH0sXG4gICAgfSk7XG5cbiAgICBhd2FpdCBoYW5kbGVEZWJ1ZyhgY29udGludWUgJHtzbHVnfWAsIGN0eCBhcyBhbnksIHBpIGFzIGFueSk7XG5cbiAgICBjb25zdCBuID0gbGFzdE5vdGlmaWNhdGlvbihjdHgpO1xuICAgIGFzc2VydC5lcXVhbChuLmxldmVsLCBcImluZm9cIik7XG4gICAgYXNzZXJ0Lm1hdGNoKG4ubWVzc2FnZSwgbmV3IFJlZ0V4cChgUmVzdW1lZCBkZWJ1ZyBzZXNzaW9uOiAke3NsdWd9YCkpO1xuICAgIGFzc2VydC5tYXRjaChuLm1lc3NhZ2UsIC9kaXNwYXRjaE1vZGU9dGRkUGhhc2U9cGVuZGluZy8pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKGNhbGxzLmxlbmd0aCwgMSwgXCJzaG91bGQgZGlzcGF0Y2ggZXhhY3RseSBvbmUgbWVzc2FnZVwiKTtcbiAgICBjb25zdCBjYWxsID0gY2FsbHNbMF07XG4gICAgYXNzZXJ0LmVxdWFsKGNhbGwucGF5bG9hZC5jdXN0b21UeXBlLCBcImdzZC1kZWJ1Zy1jb250aW51ZVwiKTtcbiAgICAvLyBBY3RpdmUgZ29hbCBtdXN0IGJlIGZpbmRfcm9vdF9jYXVzZV9vbmx5IChub3QgZmluZF9hbmRfZml4KVxuICAgIGFzc2VydC5tYXRjaChjYWxsLnBheWxvYWQuY29udGVudCwgLyMjIEdvYWxcXHMrYGZpbmRfcm9vdF9jYXVzZV9vbmx5YC8pO1xuICAgIGFzc2VydC5kb2VzTm90TWF0Y2goY2FsbC5wYXlsb2FkLmNvbnRlbnQsIC8jIyBHb2FsXFxzK2BmaW5kX2FuZF9maXhgLyk7XG4gICAgLy8gVEREIGdhdGUgc2VjdGlvbiBwcmVzZW50XG4gICAgYXNzZXJ0Lm1hdGNoKGNhbGwucGF5bG9hZC5jb250ZW50LCAvIyMgVEREIEdhdGUvKTtcbiAgICBhc3NlcnQubWF0Y2goY2FsbC5wYXlsb2FkLmNvbnRlbnQsIC9waGFzZTogcGVuZGluZy8pO1xuICAgIGFzc2VydC5tYXRjaChjYWxsLnBheWxvYWQuY29udGVudCwgL1RERCBtb2RlIGlzIGFjdGl2ZS8pO1xuICAgIC8vIGRlYnVnLXNlc3Npb24tbWFuYWdlciB0ZW1wbGF0ZSBtYXJrZXJcbiAgICBhc3NlcnQubWF0Y2goY2FsbC5wYXlsb2FkLmNvbnRlbnQsIC9TdHJ1Y3R1cmVkIFJldHVybiBQcm90b2NvbC8pO1xuICAgIGFzc2VydC5lcXVhbChjYWxsLm9wdGlvbnMudHJpZ2dlclR1cm4sIHRydWUpO1xuICB9IGZpbmFsbHkge1xuICAgIHByb2Nlc3MuY2hkaXIoc2F2ZWQpO1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiL2dzZCBkZWJ1ZyBTMDM6IFRERCBnYXRlIHJlZCBkaXNwYXRjaGVzIGZpbmRfYW5kX2ZpeCBhbmQgYWR2YW5jZXMgcGhhc2UgdG8gZ3JlZW5cIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmN3ZCgpO1xuICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuICAgIGNvbnN0IHsgY2FsbHMsIHBpIH0gPSBjcmVhdGVNb2NrUGlXaXRoRGlzcGF0Y2goKTtcblxuICAgIGNvbnN0IGNyZWF0ZWQgPSBjcmVhdGVEZWJ1Z1Nlc3Npb24oYmFzZSwgeyBpc3N1ZTogXCJBdXRoIHRva2VuIGV4cGlyeSBub3QgaGFuZGxlZFwiIH0pO1xuICAgIGNvbnN0IHNsdWcgPSBjcmVhdGVkLnNlc3Npb24uc2x1ZztcblxuICAgIHVwZGF0ZURlYnVnU2Vzc2lvbihiYXNlLCBzbHVnLCB7XG4gICAgICB0ZGRHYXRlOiB7XG4gICAgICAgIGVuYWJsZWQ6IHRydWUsXG4gICAgICAgIHBoYXNlOiBcInJlZFwiLFxuICAgICAgICB0ZXN0RmlsZTogXCJhdXRoLnRlc3QudHNcIixcbiAgICAgICAgdGVzdE5hbWU6IFwicmVqZWN0cyBleHBpcmVkIHRva2VuXCIsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgYXdhaXQgaGFuZGxlRGVidWcoYGNvbnRpbnVlICR7c2x1Z31gLCBjdHggYXMgYW55LCBwaSBhcyBhbnkpO1xuXG4gICAgY29uc3QgbiA9IGxhc3ROb3RpZmljYXRpb24oY3R4KTtcbiAgICBhc3NlcnQuZXF1YWwobi5sZXZlbCwgXCJpbmZvXCIpO1xuICAgIGFzc2VydC5tYXRjaChuLm1lc3NhZ2UsIG5ldyBSZWdFeHAoYFJlc3VtZWQgZGVidWcgc2Vzc2lvbjogJHtzbHVnfWApKTtcbiAgICBhc3NlcnQubWF0Y2gobi5tZXNzYWdlLCAvZGlzcGF0Y2hNb2RlPXRkZFBoYXNlPXJlZC8pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKGNhbGxzLmxlbmd0aCwgMSwgXCJzaG91bGQgZGlzcGF0Y2ggZXhhY3RseSBvbmUgbWVzc2FnZVwiKTtcbiAgICBjb25zdCBjYWxsID0gY2FsbHNbMF07XG4gICAgYXNzZXJ0LmVxdWFsKGNhbGwucGF5bG9hZC5jdXN0b21UeXBlLCBcImdzZC1kZWJ1Zy1jb250aW51ZVwiKTtcbiAgICBhc3NlcnQubWF0Y2goY2FsbC5wYXlsb2FkLmNvbnRlbnQsIC8jIyBHb2FsXFxzK2BmaW5kX2FuZF9maXhgLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGNhbGwucGF5bG9hZC5jb250ZW50LCAvIyMgVEREIEdhdGUvKTtcbiAgICBhc3NlcnQubWF0Y2goY2FsbC5wYXlsb2FkLmNvbnRlbnQsIC9waGFzZTogcmVkLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGNhbGwucGF5bG9hZC5jb250ZW50LCAvdGVzdEZpbGU6IGF1dGhcXC50ZXN0XFwudHMvKTtcbiAgICBhc3NlcnQubWF0Y2goY2FsbC5wYXlsb2FkLmNvbnRlbnQsIC90ZXN0TmFtZTogcmVqZWN0cyBleHBpcmVkIHRva2VuLyk7XG4gICAgYXNzZXJ0LmVxdWFsKGNhbGwub3B0aW9ucy50cmlnZ2VyVHVybiwgdHJ1ZSk7XG5cbiAgICAvLyBSZWxvYWQgYXJ0aWZhY3QgZnJvbSBkaXNrIGFuZCB2ZXJpZnkgdGRkR2F0ZS5waGFzZSBhZHZhbmNlZCB0byBncmVlblxuICAgIGNvbnN0IHJlbG9hZGVkID0gbG9hZERlYnVnU2Vzc2lvbihiYXNlLCBzbHVnKTtcbiAgICBhc3NlcnQub2socmVsb2FkZWQsIFwic2Vzc2lvbiBzaG91bGQgc3RpbGwgZXhpc3QgYWZ0ZXIgY29udGludWVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlbG9hZGVkIS5zZXNzaW9uLnRkZEdhdGU/LnBoYXNlLCBcImdyZWVuXCIsIFwidGRkR2F0ZS5waGFzZSBtdXN0IGFkdmFuY2UgcmVkXHUyMTkyZ3JlZW5cIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlbG9hZGVkIS5zZXNzaW9uLnBoYXNlLCBcImNvbnRpbnVlZFwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBwcm9jZXNzLmNoZGlyKHNhdmVkKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcIi9nc2QgZGVidWcgUzAzOiBiYWNrd2FyZCBjb21wYXQgXHUyMDE0IGxlZ2FjeSBzZXNzaW9uIHdpdGhvdXQgY2hlY2twb2ludC9UREQgdXNlcyBkZWJ1Zy1kaWFnbm9zZSB0ZW1wbGF0ZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICBjb25zdCBzYXZlZCA9IHByb2Nlc3MuY3dkKCk7XG4gIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjdHggPSBjcmVhdGVNb2NrQ3R4KCk7XG4gICAgY29uc3QgeyBjYWxscywgcGkgfSA9IGNyZWF0ZU1vY2tQaVdpdGhEaXNwYXRjaCgpO1xuXG4gICAgLy8gUzAyLWVyYSBzZXNzaW9uIFx1MjAxNCBubyBjaGVja3BvaW50LCBubyB0ZGRHYXRlIGZpZWxkcyBzZXRcbiAgICBjb25zdCBjcmVhdGVkID0gY3JlYXRlRGVidWdTZXNzaW9uKGJhc2UsIHsgaXNzdWU6IFwiUGF5bWVudCByZXRyaWVzIGhhbmcgaW5kZWZpbml0ZWx5XCIgfSk7XG4gICAgY29uc3Qgc2x1ZyA9IGNyZWF0ZWQuc2Vzc2lvbi5zbHVnO1xuXG4gICAgYXdhaXQgaGFuZGxlRGVidWcoYGNvbnRpbnVlICR7c2x1Z31gLCBjdHggYXMgYW55LCBwaSBhcyBhbnkpO1xuXG4gICAgY29uc3QgbiA9IGxhc3ROb3RpZmljYXRpb24oY3R4KTtcbiAgICBhc3NlcnQuZXF1YWwobi5sZXZlbCwgXCJpbmZvXCIpO1xuICAgIGFzc2VydC5tYXRjaChuLm1lc3NhZ2UsIG5ldyBSZWdFeHAoYFJlc3VtZWQgZGVidWcgc2Vzc2lvbjogJHtzbHVnfWApKTtcbiAgICBhc3NlcnQubWF0Y2gobi5tZXNzYWdlLCAvcGhhc2U9Y29udGludWVkLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKG4ubWVzc2FnZSwgL2Rpc3BhdGNoTW9kZT1maW5kX2FuZF9maXgvKTtcblxuICAgIGFzc2VydC5lcXVhbChjYWxscy5sZW5ndGgsIDEsIFwic2hvdWxkIGRpc3BhdGNoIGV4YWN0bHkgb25lIG1lc3NhZ2VcIik7XG4gICAgY29uc3QgY2FsbCA9IGNhbGxzWzBdO1xuICAgIGFzc2VydC5lcXVhbChjYWxsLnBheWxvYWQuY3VzdG9tVHlwZSwgXCJnc2QtZGVidWctY29udGludWVcIik7XG4gICAgLy8gZGVidWctZGlhZ25vc2UgdGVtcGxhdGU6IG5vIFN0cnVjdHVyZWQgUmV0dXJuIFByb3RvY29sLCBubyBjaGVja3BvaW50L1RERCBzZWN0aW9uc1xuICAgIGFzc2VydC5kb2VzTm90TWF0Y2goY2FsbC5wYXlsb2FkLmNvbnRlbnQsIC9TdHJ1Y3R1cmVkIFJldHVybiBQcm90b2NvbC8pO1xuICAgIGFzc2VydC5kb2VzTm90TWF0Y2goY2FsbC5wYXlsb2FkLmNvbnRlbnQsIC8jIyBBY3RpdmUgQ2hlY2twb2ludC8pO1xuICAgIGFzc2VydC5kb2VzTm90TWF0Y2goY2FsbC5wYXlsb2FkLmNvbnRlbnQsIC8jIyBUREQgR2F0ZS8pO1xuICAgIGFzc2VydC5tYXRjaChjYWxsLnBheWxvYWQuY29udGVudCwgL2ZpbmRfYW5kX2ZpeC8pO1xuICAgIGFzc2VydC5lcXVhbChjYWxsLm9wdGlvbnMudHJpZ2dlclR1cm4sIHRydWUpO1xuICB9IGZpbmFsbHkge1xuICAgIHByb2Nlc3MuY2hkaXIoc2F2ZWQpO1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiL2dzZCBkZWJ1ZyBTMDM6IHJvdW5kLXRyaXAgXHUyMDE0IGNoZWNrcG9pbnQgd2l0aCB1c2VyUmVzcG9uc2UgZGlzcGF0Y2hlcyByZXNwb25zZSBhbmQgc2Vzc2lvbiB0cmFuc2l0aW9ucyB0byBjb250aW51ZWRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmN3ZCgpO1xuICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuICAgIGNvbnN0IHsgY2FsbHMsIHBpIH0gPSBjcmVhdGVNb2NrUGlXaXRoRGlzcGF0Y2goKTtcblxuICAgIGNvbnN0IGNyZWF0ZWQgPSBjcmVhdGVEZWJ1Z1Nlc3Npb24oYmFzZSwgeyBpc3N1ZTogXCJDYWNoZSBpbnZhbGlkYXRpb24gcmFjZSBvbiBkZXBsb3lcIiB9KTtcbiAgICBjb25zdCBzbHVnID0gY3JlYXRlZC5zZXNzaW9uLnNsdWc7XG5cbiAgICAvLyBTaW11bGF0ZSBhZ2VudCBzZXR0aW5nIGNoZWNrcG9pbnQsIHRoZW4gdXNlciBwcm92aWRpbmcgYSByZXNwb25zZVxuICAgIHVwZGF0ZURlYnVnU2Vzc2lvbihiYXNlLCBzbHVnLCB7XG4gICAgICBjaGVja3BvaW50OiB7XG4gICAgICAgIHR5cGU6IFwiaHVtYW4tdmVyaWZ5XCIsXG4gICAgICAgIHN1bW1hcnk6IFwiQ2hlY2sgd2hldGhlciBzdGFsZSBrZXlzIGFwcGVhciBhZnRlciBkZXBsb3lcIixcbiAgICAgICAgYXdhaXRpbmdSZXNwb25zZTogdHJ1ZSxcbiAgICAgICAgdXNlclJlc3BvbnNlOiBcIkNvbmZpcm1lZCBvbiBzdGFnaW5nXCIsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgYXdhaXQgaGFuZGxlRGVidWcoYGNvbnRpbnVlICR7c2x1Z31gLCBjdHggYXMgYW55LCBwaSBhcyBhbnkpO1xuXG4gICAgY29uc3QgbiA9IGxhc3ROb3RpZmljYXRpb24oY3R4KTtcbiAgICBhc3NlcnQuZXF1YWwobi5sZXZlbCwgXCJpbmZvXCIpO1xuICAgIGFzc2VydC5tYXRjaChuLm1lc3NhZ2UsIG5ldyBSZWdFeHAoYFJlc3VtZWQgZGVidWcgc2Vzc2lvbjogJHtzbHVnfWApKTtcbiAgICBhc3NlcnQubWF0Y2gobi5tZXNzYWdlLCAvcGhhc2U9Y29udGludWVkLyk7XG5cbiAgICBhc3NlcnQuZXF1YWwoY2FsbHMubGVuZ3RoLCAxLCBcInNob3VsZCBkaXNwYXRjaCBleGFjdGx5IG9uZSBtZXNzYWdlXCIpO1xuICAgIGNvbnN0IGNhbGwgPSBjYWxsc1swXTtcbiAgICBhc3NlcnQuZXF1YWwoY2FsbC5wYXlsb2FkLmN1c3RvbVR5cGUsIFwiZ3NkLWRlYnVnLWNvbnRpbnVlXCIpO1xuICAgIC8vIHVzZXJSZXNwb25zZSBlbWJlZGRlZCBpbiBEQVRBX1NUQVJUL0RBVEFfRU5EIHNlY3VyaXR5IHdyYXBwZXJcbiAgICBhc3NlcnQubWF0Y2goY2FsbC5wYXlsb2FkLmNvbnRlbnQsIC9EQVRBX1NUQVJULyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGNhbGwucGF5bG9hZC5jb250ZW50LCAvQ29uZmlybWVkIG9uIHN0YWdpbmcvKTtcbiAgICBhc3NlcnQubWF0Y2goY2FsbC5wYXlsb2FkLmNvbnRlbnQsIC9EQVRBX0VORC8pO1xuICAgIGFzc2VydC5lcXVhbChjYWxsLm9wdGlvbnMudHJpZ2dlclR1cm4sIHRydWUpO1xuXG4gICAgLy8gVmVyaWZ5IHNlc3Npb24gc3RhdGUgcGVyc2lzdGVkIHRvIGRpc2sgYWZ0ZXIgY29udGludWVcbiAgICBjb25zdCByZWxvYWRlZCA9IGxvYWREZWJ1Z1Nlc3Npb24oYmFzZSwgc2x1Zyk7XG4gICAgYXNzZXJ0Lm9rKHJlbG9hZGVkLCBcInNlc3Npb24gc2hvdWxkIHN0aWxsIGV4aXN0XCIpO1xuICAgIGFzc2VydC5lcXVhbChyZWxvYWRlZCEuc2Vzc2lvbi5waGFzZSwgXCJjb250aW51ZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlbG9hZGVkIS5zZXNzaW9uLnN0YXR1cywgXCJhY3RpdmVcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcHJvY2Vzcy5jaGRpcihzYXZlZCk7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMCBTMDQgdGVzdHM6IHNwZWNpYWxpc3QgcmV2aWV3IGRpc3BhdGNoIGFuZCBkaXNrLXJlbG9hZCB2ZXJpZmljYXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCIvZ3NkIGRlYnVnIFMwNDogc3BlY2lhbGlzdCByZXZpZXcgcm91bmQtdHJpcCB0aHJvdWdoIGNvbnRpbnVlIGRpc3BhdGNoXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIGNvbnN0IHNhdmVkID0gcHJvY2Vzcy5jd2QoKTtcbiAgcHJvY2Vzcy5jaGRpcihiYXNlKTtcblxuICB0cnkge1xuICAgIGNvbnN0IGN0eCA9IGNyZWF0ZU1vY2tDdHgoKTtcbiAgICBjb25zdCB7IGNhbGxzLCBwaSB9ID0gY3JlYXRlTW9ja1BpV2l0aERpc3BhdGNoKCk7XG5cbiAgICBjb25zdCBjcmVhdGVkID0gY3JlYXRlRGVidWdTZXNzaW9uKGJhc2UsIHsgaXNzdWU6IFwiVW5zYWZlIHR5cGUgYXNzZXJ0aW9uIGluIGF1dGggZmxvd1wiIH0pO1xuICAgIGNvbnN0IHNsdWcgPSBjcmVhdGVkLnNlc3Npb24uc2x1ZztcblxuICAgIC8vIE5lZWQgY2hlY2twb2ludCB0byB0cmlnZ2VyIGRlYnVnLXNlc3Npb24tbWFuYWdlciB0ZW1wbGF0ZSAod2hpY2ggaW5jbHVkZXMgc3BlY2lhbGlzdENvbnRleHQpXG4gICAgdXBkYXRlRGVidWdTZXNzaW9uKGJhc2UsIHNsdWcsIHtcbiAgICAgIGNoZWNrcG9pbnQ6IHtcbiAgICAgICAgdHlwZTogXCJodW1hbi12ZXJpZnlcIixcbiAgICAgICAgc3VtbWFyeTogXCJWZXJpZnkgdHlwZSBndWFyZCBpcyBzYWZlIG9uIGFsbCBhdXRoIHBhdGhzXCIsXG4gICAgICAgIGF3YWl0aW5nUmVzcG9uc2U6IHRydWUsXG4gICAgICB9LFxuICAgICAgc3BlY2lhbGlzdFJldmlldzoge1xuICAgICAgICBoaW50OiBcInR5cGVzY3JpcHRcIixcbiAgICAgICAgc2tpbGw6IFwidHlwZXNjcmlwdC1leHBlcnRcIixcbiAgICAgICAgdmVyZGljdDogXCJTVUdHRVNUX0NIQU5HRSAodXNlIHR5cGUgZ3VhcmQpXCIsXG4gICAgICAgIGRldGFpbDogXCJUaGUgY3VycmVudCBpbXBsZW1lbnRhdGlvbiB1c2VzIHVuc2FmZSB0eXBlIGFzc2VydGlvblwiLFxuICAgICAgICByZXZpZXdlZEF0OiAxNzAwMDAwMDAwMDAwLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGF3YWl0IGhhbmRsZURlYnVnKGBjb250aW51ZSAke3NsdWd9YCwgY3R4IGFzIGFueSwgcGkgYXMgYW55KTtcblxuICAgIGNvbnN0IG4gPSBsYXN0Tm90aWZpY2F0aW9uKGN0eCk7XG4gICAgYXNzZXJ0LmVxdWFsKG4ubGV2ZWwsIFwiaW5mb1wiKTtcbiAgICBhc3NlcnQubWF0Y2gobi5tZXNzYWdlLCBuZXcgUmVnRXhwKGBSZXN1bWVkIGRlYnVnIHNlc3Npb246ICR7c2x1Z31gKSk7XG4gICAgYXNzZXJ0Lm1hdGNoKG4ubWVzc2FnZSwgL3BoYXNlPWNvbnRpbnVlZC8pO1xuICAgIC8vIE5vdGlmaWNhdGlvbiBtdXN0IGNhcnJ5IHNwZWNpYWxpc3RIaW50IGxhYmVsXG4gICAgYXNzZXJ0Lm1hdGNoKG4ubWVzc2FnZSwgL3NwZWNpYWxpc3RIaW50PXR5cGVzY3JpcHQvKTtcblxuICAgIGFzc2VydC5lcXVhbChjYWxscy5sZW5ndGgsIDEsIFwic2hvdWxkIGRpc3BhdGNoIGV4YWN0bHkgb25lIG1lc3NhZ2VcIik7XG4gICAgY29uc3QgY2FsbCA9IGNhbGxzWzBdO1xuICAgIGFzc2VydC5lcXVhbChjYWxsLnBheWxvYWQuY3VzdG9tVHlwZSwgXCJnc2QtZGVidWctY29udGludWVcIik7XG4gICAgLy8gZGVidWctc2Vzc2lvbi1tYW5hZ2VyIHRlbXBsYXRlIG1hcmtlciBjb25maXJtcyBjb3JyZWN0IHRlbXBsYXRlIHdhcyB1c2VkXG4gICAgYXNzZXJ0Lm1hdGNoKGNhbGwucGF5bG9hZC5jb250ZW50LCAvU3RydWN0dXJlZCBSZXR1cm4gUHJvdG9jb2wvKTtcbiAgICAvLyBTcGVjaWFsaXN0IGNvbnRleHQgZW1iZWRkZWQgaW4gcGF5bG9hZFxuICAgIGFzc2VydC5tYXRjaChjYWxsLnBheWxvYWQuY29udGVudCwgL1ByaW9yIFNwZWNpYWxpc3QgUmV2aWV3Lyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGNhbGwucGF5bG9hZC5jb250ZW50LCAvaGludDogdHlwZXNjcmlwdC8pO1xuICAgIGFzc2VydC5tYXRjaChjYWxsLnBheWxvYWQuY29udGVudCwgL1NVR0dFU1RfQ0hBTkdFIFxcKHVzZSB0eXBlIGd1YXJkXFwpLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGNhbGwucGF5bG9hZC5jb250ZW50LCAvVGhlIGN1cnJlbnQgaW1wbGVtZW50YXRpb24gdXNlcyB1bnNhZmUgdHlwZSBhc3NlcnRpb24vKTtcbiAgICBhc3NlcnQuZXF1YWwoY2FsbC5vcHRpb25zLnRyaWdnZXJUdXJuLCB0cnVlKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBwcm9jZXNzLmNoZGlyKHNhdmVkKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcIi9nc2QgZGVidWcgUzA0OiBiYWNrd2FyZCBjb21wYXQgXHUyMDE0IHNlc3Npb24gd2l0aG91dCBzcGVjaWFsaXN0UmV2aWV3IGNvbnRpbnVlcyBub3JtYWxseVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICBjb25zdCBzYXZlZCA9IHByb2Nlc3MuY3dkKCk7XG4gIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjdHggPSBjcmVhdGVNb2NrQ3R4KCk7XG4gICAgY29uc3QgeyBjYWxscywgcGkgfSA9IGNyZWF0ZU1vY2tQaVdpdGhEaXNwYXRjaCgpO1xuXG4gICAgLy8gQ2hlY2twb2ludC1vbmx5IHNlc3Npb24gXHUyMDE0IHRyaWdnZXJzIGRlYnVnLXNlc3Npb24tbWFuYWdlciBidXQgaGFzIE5PIHNwZWNpYWxpc3RSZXZpZXdcbiAgICBjb25zdCBjcmVhdGVkID0gY3JlYXRlRGVidWdTZXNzaW9uKGJhc2UsIHsgaXNzdWU6IFwiTWVtb3J5IGxlYWsgaW4gZXZlbnQgYnVzXCIgfSk7XG4gICAgY29uc3Qgc2x1ZyA9IGNyZWF0ZWQuc2Vzc2lvbi5zbHVnO1xuXG4gICAgdXBkYXRlRGVidWdTZXNzaW9uKGJhc2UsIHNsdWcsIHtcbiAgICAgIGNoZWNrcG9pbnQ6IHtcbiAgICAgICAgdHlwZTogXCJodW1hbi12ZXJpZnlcIixcbiAgICAgICAgc3VtbWFyeTogXCJDb25maXJtIGxlYWsgZGlzYXBwZWFycyBhZnRlciBmaXhcIixcbiAgICAgICAgYXdhaXRpbmdSZXNwb25zZTogdHJ1ZSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBhd2FpdCBoYW5kbGVEZWJ1ZyhgY29udGludWUgJHtzbHVnfWAsIGN0eCBhcyBhbnksIHBpIGFzIGFueSk7XG5cbiAgICBjb25zdCBuID0gbGFzdE5vdGlmaWNhdGlvbihjdHgpO1xuICAgIGFzc2VydC5lcXVhbChuLmxldmVsLCBcImluZm9cIik7XG4gICAgYXNzZXJ0Lm1hdGNoKG4ubWVzc2FnZSwgbmV3IFJlZ0V4cChgUmVzdW1lZCBkZWJ1ZyBzZXNzaW9uOiAke3NsdWd9YCkpO1xuICAgIGFzc2VydC5tYXRjaChuLm1lc3NhZ2UsIC9waGFzZT1jb250aW51ZWQvKTtcbiAgICAvLyBObyBzcGVjaWFsaXN0SGludCBsYWJlbCBpbiBub3RpZmljYXRpb25cbiAgICBhc3NlcnQuZG9lc05vdE1hdGNoKG4ubWVzc2FnZSwgL3NwZWNpYWxpc3RIaW50PS8pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKGNhbGxzLmxlbmd0aCwgMSwgXCJzaG91bGQgZGlzcGF0Y2ggZXhhY3RseSBvbmUgbWVzc2FnZVwiKTtcbiAgICBjb25zdCBjYWxsID0gY2FsbHNbMF07XG4gICAgYXNzZXJ0LmVxdWFsKGNhbGwucGF5bG9hZC5jdXN0b21UeXBlLCBcImdzZC1kZWJ1Zy1jb250aW51ZVwiKTtcbiAgICAvLyBkZWJ1Zy1zZXNzaW9uLW1hbmFnZXIgdGVtcGxhdGUgaXMgc3RpbGwgdXNlZCAoY2hlY2twb2ludCB0cmlnZ2VycyBpdClcbiAgICBhc3NlcnQubWF0Y2goY2FsbC5wYXlsb2FkLmNvbnRlbnQsIC9TdHJ1Y3R1cmVkIFJldHVybiBQcm90b2NvbC8pO1xuICAgIC8vIE5vIHNwZWNpYWxpc3QgY29udGV4dCBzZWN0aW9uIGluIHBheWxvYWQgKHRlbXBsYXRlJ3Mgb3duIFNwZWNpYWxpc3QgRGlzcGF0Y2ggZG9jcyBkb24ndCBjb3VudClcbiAgICBhc3NlcnQuZG9lc05vdE1hdGNoKGNhbGwucGF5bG9hZC5jb250ZW50LCAvUHJpb3IgU3BlY2lhbGlzdCBSZXZpZXcvKTtcbiAgICBhc3NlcnQuZXF1YWwoY2FsbC5vcHRpb25zLnRyaWdnZXJUdXJuLCB0cnVlKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBwcm9jZXNzLmNoZGlyKHNhdmVkKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcIi9nc2QgZGVidWcgUzA0OiBzcGVjaWFsaXN0IHJldmlldyBwZXJzaXN0cyB0aHJvdWdoIGNvbnRpbnVlIHdpdGggZGlzayByZWxvYWRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmN3ZCgpO1xuICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuICAgIGNvbnN0IHsgY2FsbHMsIHBpIH0gPSBjcmVhdGVNb2NrUGlXaXRoRGlzcGF0Y2goKTtcblxuICAgIGNvbnN0IGNyZWF0ZWQgPSBjcmVhdGVEZWJ1Z1Nlc3Npb24oYmFzZSwgeyBpc3N1ZTogXCJSYWNlIGNvbmRpdGlvbiBpbiBwYXltZW50IGZpbmFsaXplclwiIH0pO1xuICAgIGNvbnN0IHNsdWcgPSBjcmVhdGVkLnNlc3Npb24uc2x1ZztcblxuICAgIC8vIENoZWNrcG9pbnQgKyBzcGVjaWFsaXN0UmV2aWV3IFx1MjAxNCBjb250aW51ZSB1cGRhdGVzIHN0YXR1cy9waGFzZS9sYXN0RXJyb3IgYnV0IG11c3QgcHJlc2VydmUgc3BlY2lhbGlzdFJldmlld1xuICAgIHVwZGF0ZURlYnVnU2Vzc2lvbihiYXNlLCBzbHVnLCB7XG4gICAgICBjaGVja3BvaW50OiB7XG4gICAgICAgIHR5cGU6IFwicm9vdC1jYXVzZS1mb3VuZFwiLFxuICAgICAgICBzdW1tYXJ5OiBcIlJhY2UgYmV0d2VlbiBmaW5hbGl6ZXIgYW5kIEdDIGhvb2sgY29uZmlybWVkXCIsXG4gICAgICAgIGF3YWl0aW5nUmVzcG9uc2U6IHRydWUsXG4gICAgICB9LFxuICAgICAgc3BlY2lhbGlzdFJldmlldzoge1xuICAgICAgICBoaW50OiBcInR5cGVzY3JpcHRcIixcbiAgICAgICAgc2tpbGw6IFwidHlwZXNjcmlwdC1leHBlcnRcIixcbiAgICAgICAgdmVyZGljdDogXCJMT09LU19HT09EXCIsXG4gICAgICAgIGRldGFpbDogXCJXZWFrUmVmIHBhdHRlcm4gY29ycmVjdGx5IGF2b2lkcyB0aGUgR0MgcmFjZVwiLFxuICAgICAgICByZXZpZXdlZEF0OiAxNzAwMDAwMDAxMDAwLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGF3YWl0IGhhbmRsZURlYnVnKGBjb250aW51ZSAke3NsdWd9YCwgY3R4IGFzIGFueSwgcGkgYXMgYW55KTtcblxuICAgIGFzc2VydC5lcXVhbChjYWxscy5sZW5ndGgsIDEsIFwic2hvdWxkIGRpc3BhdGNoIGV4YWN0bHkgb25lIG1lc3NhZ2VcIik7XG5cbiAgICAvLyBSZWxvYWQgdGhlIGFydGlmYWN0IGZyb20gZGlzayBhbmQgdmVyaWZ5IHNwZWNpYWxpc3RSZXZpZXcgc3Vydml2ZWQgdGhlIGhhbmRsZXIncyB1cGRhdGVEZWJ1Z1Nlc3Npb24gY2FsbFxuICAgIGNvbnN0IHJlbG9hZGVkID0gbG9hZERlYnVnU2Vzc2lvbihiYXNlLCBzbHVnKTtcbiAgICBhc3NlcnQub2socmVsb2FkZWQsIFwic2Vzc2lvbiBtdXN0IHN0aWxsIGV4aXN0IG9uIGRpc2sgYWZ0ZXIgY29udGludWVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlbG9hZGVkIS5zZXNzaW9uLnBoYXNlLCBcImNvbnRpbnVlZFwiLCBcInBoYXNlIG11c3QgYmUgdXBkYXRlZCB0byBjb250aW51ZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlbG9hZGVkIS5zZXNzaW9uLnN0YXR1cywgXCJhY3RpdmVcIiwgXCJzdGF0dXMgbXVzdCBiZSBhY3RpdmVcIik7XG4gICAgYXNzZXJ0Lm9rKHJlbG9hZGVkIS5zZXNzaW9uLnNwZWNpYWxpc3RSZXZpZXcgIT0gbnVsbCwgXCJzcGVjaWFsaXN0UmV2aWV3IG11c3QgYmUgcHJlc2VydmVkIChub3Qgd2lwZWQgYnkgY29udGludWUpXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZWxvYWRlZCEuc2Vzc2lvbi5zcGVjaWFsaXN0UmV2aWV3IS5oaW50LCBcInR5cGVzY3JpcHRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlbG9hZGVkIS5zZXNzaW9uLnNwZWNpYWxpc3RSZXZpZXchLnZlcmRpY3QsIFwiTE9PS1NfR09PRFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVsb2FkZWQhLnNlc3Npb24uc3BlY2lhbGlzdFJldmlldyEuc2tpbGwsIFwidHlwZXNjcmlwdC1leHBlcnRcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcHJvY2Vzcy5jaGRpcihzYXZlZCk7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMCBTMDUgdGVzdHM6IGZ1bGwgbGlmZWN5Y2xlIGVuZC10by1lbmQgcGFyaXR5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiL2dzZCBkZWJ1ZyBTMDU6IGZ1bGwgaGFwcHktcGF0aCBsaWZlY3ljbGUgXHUyMDE0IHN0YXJ0IFx1MjE5MiBsaXN0IFx1MjE5MiBzdGF0dXMgXHUyMTkyIGNvbnRpbnVlIFx1MjE5MiByZXNvbHZlIFx1MjE5MiBjb250aW51ZS1ibG9ja2VkXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIGNvbnN0IHNhdmVkID0gcHJvY2Vzcy5jd2QoKTtcbiAgcHJvY2Vzcy5jaGRpcihiYXNlKTtcblxuICB0cnkge1xuICAgIGNvbnN0IGN0eCA9IGNyZWF0ZU1vY2tDdHgoKTtcbiAgICBjb25zdCB7IGNhbGxzLCBwaSB9ID0gY3JlYXRlTW9ja1BpV2l0aERpc3BhdGNoKCk7XG5cbiAgICAvLyAxLiBTdGFydCBzZXNzaW9uXG4gICAgYXdhaXQgaGFuZGxlR1NEQ29tbWFuZChcImRlYnVnIFdpZGdldCBmYWlscyBvbiBtb2JpbGVcIiwgY3R4IGFzIGFueSwge30gYXMgYW55KTtcbiAgICBjb25zdCBzdGFydGVkID0gbGFzdE5vdGlmaWNhdGlvbihjdHgpO1xuICAgIGFzc2VydC5lcXVhbChzdGFydGVkLmxldmVsLCBcImluZm9cIik7XG4gICAgYXNzZXJ0Lm1hdGNoKHN0YXJ0ZWQubWVzc2FnZSwgL0RlYnVnIHNlc3Npb24gc3RhcnRlZDogd2lkZ2V0LWZhaWxzLW9uLW1vYmlsZS8pO1xuICAgIGNvbnN0IHNsdWcgPSBcIndpZGdldC1mYWlscy1vbi1tb2JpbGVcIjtcblxuICAgIC8vIDIuIExpc3Qgc2hvd3MgdGhlIG5ldyBzZXNzaW9uXG4gICAgYXdhaXQgaGFuZGxlR1NEQ29tbWFuZChcImRlYnVnIGxpc3RcIiwgY3R4IGFzIGFueSwge30gYXMgYW55KTtcbiAgICBjb25zdCBsaXN0ZWQgPSBsYXN0Tm90aWZpY2F0aW9uKGN0eCk7XG4gICAgYXNzZXJ0LmVxdWFsKGxpc3RlZC5sZXZlbCwgXCJpbmZvXCIpO1xuICAgIGFzc2VydC5tYXRjaChsaXN0ZWQubWVzc2FnZSwgL0RlYnVnIHNlc3Npb25zOi8pO1xuICAgIGFzc2VydC5tYXRjaChsaXN0ZWQubWVzc2FnZSwgL3dpZGdldC1mYWlscy1vbi1tb2JpbGUvKTtcbiAgICBhc3NlcnQubWF0Y2gobGlzdGVkLm1lc3NhZ2UsIC9tb2RlPWRlYnVnIHN0YXR1cz1hY3RpdmUgcGhhc2U9cXVldWVkLyk7XG5cbiAgICAvLyAzLiBTdGF0dXMgc2hvd3MgZXhwZWN0ZWQgZmllbGRzXG4gICAgYXdhaXQgaGFuZGxlR1NEQ29tbWFuZChgZGVidWcgc3RhdHVzICR7c2x1Z31gLCBjdHggYXMgYW55LCB7fSBhcyBhbnkpO1xuICAgIGNvbnN0IHN0YXR1cyA9IGxhc3ROb3RpZmljYXRpb24oY3R4KTtcbiAgICBhc3NlcnQuZXF1YWwoc3RhdHVzLmxldmVsLCBcImluZm9cIik7XG4gICAgYXNzZXJ0Lm1hdGNoKHN0YXR1cy5tZXNzYWdlLCBuZXcgUmVnRXhwKGBeRGVidWcgc2Vzc2lvbiBzdGF0dXM6ICR7c2x1Z31gLCBcIm1cIikpO1xuICAgIGFzc2VydC5tYXRjaChzdGF0dXMubWVzc2FnZSwgL15tb2RlPWRlYnVnJC9tKTtcbiAgICBhc3NlcnQubWF0Y2goc3RhdHVzLm1lc3NhZ2UsIC9ec3RhdHVzPWFjdGl2ZSQvbSk7XG4gICAgYXNzZXJ0Lm1hdGNoKHN0YXR1cy5tZXNzYWdlLCAvXnBoYXNlPXF1ZXVlZCQvbSk7XG5cbiAgICAvLyA0LiBDb250aW51ZSBkaXNwYXRjaGVzIGZpbmRfYW5kX2ZpeCBnb2FsIHZpYSBkZWJ1Zy1kaWFnbm9zZSB0ZW1wbGF0ZSAobm8gY2hlY2twb2ludC9UREQpXG4gICAgYXdhaXQgaGFuZGxlRGVidWcoYGNvbnRpbnVlICR7c2x1Z31gLCBjdHggYXMgYW55LCBwaSBhcyBhbnkpO1xuICAgIGNvbnN0IHJlc3VtZWQgPSBsYXN0Tm90aWZpY2F0aW9uKGN0eCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VtZWQubGV2ZWwsIFwiaW5mb1wiKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdW1lZC5tZXNzYWdlLCBuZXcgUmVnRXhwKGBSZXN1bWVkIGRlYnVnIHNlc3Npb246ICR7c2x1Z31gKSk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VtZWQubWVzc2FnZSwgL2Rpc3BhdGNoTW9kZT1maW5kX2FuZF9maXgvKTtcblxuICAgIGFzc2VydC5lcXVhbChjYWxscy5sZW5ndGgsIDEsIFwic2hvdWxkIGRpc3BhdGNoIGV4YWN0bHkgb25lIG1lc3NhZ2Ugb24gY29udGludWVcIik7XG4gICAgY29uc3QgY2FsbCA9IGNhbGxzWzBdO1xuICAgIGFzc2VydC5lcXVhbChjYWxsLnBheWxvYWQuY3VzdG9tVHlwZSwgXCJnc2QtZGVidWctY29udGludWVcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKGNhbGwucGF5bG9hZC5jb250ZW50LCAvZmluZF9hbmRfZml4Lyk7XG4gICAgYXNzZXJ0LmVxdWFsKGNhbGwub3B0aW9ucy50cmlnZ2VyVHVybiwgdHJ1ZSk7XG5cbiAgICAvLyA1LiBNYXJrIHNlc3Npb24gcmVzb2x2ZWQ7IGNsZWFyIGNhbGxzXG4gICAgdXBkYXRlRGVidWdTZXNzaW9uKGJhc2UsIHNsdWcsIHsgc3RhdHVzOiBcInJlc29sdmVkXCIgfSk7XG4gICAgY2FsbHMubGVuZ3RoID0gMDtcblxuICAgIC8vIDYuIENvbnRpbnVlIG9uIHJlc29sdmVkIHNlc3Npb24gZW1pdHMgd2FybmluZyBhbmQgZG9lcyBub3QgZGlzcGF0Y2hcbiAgICBhd2FpdCBoYW5kbGVEZWJ1ZyhgY29udGludWUgJHtzbHVnfWAsIGN0eCBhcyBhbnksIHBpIGFzIGFueSk7XG4gICAgY29uc3QgYmxvY2tlZFdhcm5pbmcgPSBsYXN0Tm90aWZpY2F0aW9uKGN0eCk7XG4gICAgYXNzZXJ0LmVxdWFsKGJsb2NrZWRXYXJuaW5nLmxldmVsLCBcIndhcm5pbmdcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKGJsb2NrZWRXYXJuaW5nLm1lc3NhZ2UsIG5ldyBSZWdFeHAoYFNlc3Npb24gJyR7c2x1Z30nIGlzIHJlc29sdmVkYCkpO1xuICAgIGFzc2VydC5lcXVhbChjYWxscy5sZW5ndGgsIDAsIFwibm8gZGlzcGF0Y2ggZm9yIHJlc29sdmVkIHNlc3Npb25cIik7XG4gIH0gZmluYWxseSB7XG4gICAgcHJvY2Vzcy5jaGRpcihzYXZlZCk7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCIvZ3NkIGRlYnVnIFMwNTogZGlhZ25vc2Utb25seSBmdWxsIGxpZmVjeWNsZSBcdTIwMTQgc3RhcnQgXHUyMTkyIHN0YXR1cyhtb2RlPWRpYWdub3NlKSBcdTIxOTIgY29udGludWUgdXNlcyBkZWJ1Zy1kaWFnbm9zZSB0ZW1wbGF0ZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICBjb25zdCBzYXZlZCA9IHByb2Nlc3MuY3dkKCk7XG4gIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjdHggPSBjcmVhdGVNb2NrQ3R4KCk7XG4gICAgY29uc3QgeyBjYWxscywgcGkgfSA9IGNyZWF0ZU1vY2tQaVdpdGhEaXNwYXRjaCgpO1xuXG4gICAgLy8gMS4gU3RhcnQgZGlhZ25vc2Ugc2Vzc2lvbiB2aWEgLS1kaWFnbm9zZSA8aXNzdWU+XG4gICAgYXdhaXQgaGFuZGxlRGVidWcoXCItLWRpYWdub3NlIE1lbW9yeSBsZWFrIGluIHdvcmtlciBwb29sXCIsIGN0eCBhcyBhbnksIHBpIGFzIGFueSk7XG4gICAgY29uc3Qgc3RhcnRlZCA9IGxhc3ROb3RpZmljYXRpb24oY3R4KTtcbiAgICBhc3NlcnQuZXF1YWwoc3RhcnRlZC5sZXZlbCwgXCJpbmZvXCIpO1xuICAgIGFzc2VydC5tYXRjaChzdGFydGVkLm1lc3NhZ2UsIC9EaWFnbm9zZSBzZXNzaW9uIHN0YXJ0ZWQ6Lyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHN0YXJ0ZWQubWVzc2FnZSwgL21vZGU9ZGlhZ25vc2UvKTtcbiAgICBhc3NlcnQubWF0Y2goc3RhcnRlZC5tZXNzYWdlLCAvZGlzcGF0Y2hNb2RlPWZpbmRfcm9vdF9jYXVzZV9vbmx5Lyk7XG5cbiAgICBhc3NlcnQuZXF1YWwoY2FsbHMubGVuZ3RoLCAxLCBcInNob3VsZCBkaXNwYXRjaCBleGFjdGx5IG9uZSBtZXNzYWdlIG9uIGRpYWdub3NlLXN0YXJ0XCIpO1xuICAgIGNvbnN0IGRpYWdub3NlQ2FsbCA9IGNhbGxzWzBdO1xuICAgIGFzc2VydC5lcXVhbChkaWFnbm9zZUNhbGwucGF5bG9hZC5jdXN0b21UeXBlLCBcImdzZC1kZWJ1Zy1kaWFnbm9zZVwiKTtcbiAgICBhc3NlcnQubWF0Y2goZGlhZ25vc2VDYWxsLnBheWxvYWQuY29udGVudCwgL2ZpbmRfcm9vdF9jYXVzZV9vbmx5Lyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGRpYWdub3NlQ2FsbC5wYXlsb2FkLmNvbnRlbnQsIC9NZW1vcnkgbGVhayBpbiB3b3JrZXIgcG9vbC9pKTtcbiAgICBhc3NlcnQuZXF1YWwoZGlhZ25vc2VDYWxsLm9wdGlvbnMudHJpZ2dlclR1cm4sIHRydWUpO1xuXG4gICAgY29uc3Qgc2x1ZyA9IFwibWVtb3J5LWxlYWstaW4td29ya2VyLXBvb2xcIjtcblxuICAgIC8vIDIuIFN0YXR1cyBzaG93cyBtb2RlPWRpYWdub3NlXG4gICAgYXdhaXQgaGFuZGxlR1NEQ29tbWFuZChgZGVidWcgc3RhdHVzICR7c2x1Z31gLCBjdHggYXMgYW55LCB7fSBhcyBhbnkpO1xuICAgIGNvbnN0IHN0YXR1cyA9IGxhc3ROb3RpZmljYXRpb24oY3R4KTtcbiAgICBhc3NlcnQuZXF1YWwoc3RhdHVzLmxldmVsLCBcImluZm9cIik7XG4gICAgYXNzZXJ0Lm1hdGNoKHN0YXR1cy5tZXNzYWdlLCAvXm1vZGU9ZGlhZ25vc2UkL20pO1xuICAgIGFzc2VydC5tYXRjaChzdGF0dXMubWVzc2FnZSwgL15zdGF0dXM9YWN0aXZlJC9tKTtcblxuICAgIC8vIDMuIENvbnRpbnVlIHdpdGggbm8gY2hlY2twb2ludC9UREQgdXNlcyBkZWJ1Zy1kaWFnbm9zZSB0ZW1wbGF0ZSAobm8gU3RydWN0dXJlZCBSZXR1cm4gUHJvdG9jb2wpXG4gICAgY2FsbHMubGVuZ3RoID0gMDtcbiAgICBhd2FpdCBoYW5kbGVEZWJ1ZyhgY29udGludWUgJHtzbHVnfWAsIGN0eCBhcyBhbnksIHBpIGFzIGFueSk7XG4gICAgY29uc3QgcmVzdW1lZCA9IGxhc3ROb3RpZmljYXRpb24oY3R4KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdW1lZC5sZXZlbCwgXCJpbmZvXCIpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bWVkLm1lc3NhZ2UsIG5ldyBSZWdFeHAoYFJlc3VtZWQgZGVidWcgc2Vzc2lvbjogJHtzbHVnfWApKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdW1lZC5tZXNzYWdlLCAvZGlzcGF0Y2hNb2RlPWZpbmRfYW5kX2ZpeC8pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKGNhbGxzLmxlbmd0aCwgMSwgXCJzaG91bGQgZGlzcGF0Y2ggZXhhY3RseSBvbmUgbWVzc2FnZSBvbiBjb250aW51ZVwiKTtcbiAgICBjb25zdCBjb250aW51ZUNhbGwgPSBjYWxsc1swXTtcbiAgICBhc3NlcnQuZXF1YWwoY29udGludWVDYWxsLnBheWxvYWQuY3VzdG9tVHlwZSwgXCJnc2QtZGVidWctY29udGludWVcIik7XG4gICAgLy8gZGVidWctZGlhZ25vc2UgdGVtcGxhdGU6IG5vIFN0cnVjdHVyZWQgUmV0dXJuIFByb3RvY29sICh0aGF0IG1hcmtlciBpcyBkZWJ1Zy1zZXNzaW9uLW1hbmFnZXIgb25seSlcbiAgICBhc3NlcnQuZG9lc05vdE1hdGNoKGNvbnRpbnVlQ2FsbC5wYXlsb2FkLmNvbnRlbnQsIC9TdHJ1Y3R1cmVkIFJldHVybiBQcm90b2NvbC8pO1xuICAgIGFzc2VydC5tYXRjaChjb250aW51ZUNhbGwucGF5bG9hZC5jb250ZW50LCAvZmluZF9hbmRfZml4Lyk7XG4gICAgYXNzZXJ0LmVxdWFsKGNvbnRpbnVlQ2FsbC5vcHRpb25zLnRyaWdnZXJUdXJuLCB0cnVlKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBwcm9jZXNzLmNoZGlyKHNhdmVkKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcIi9nc2QgZGVidWcgUzA1OiBUREQgZnVsbCBjeWNsZSBcdTIwMTQgcGVuZGluZyBcdTIxOTIgcmVkIFx1MjE5MiBncmVlbiB3aXRoIGRpc2stcmVsb2FkIHZlcmlmaWNhdGlvbiBhdCBlYWNoIHBoYXNlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIGNvbnN0IHNhdmVkID0gcHJvY2Vzcy5jd2QoKTtcbiAgcHJvY2Vzcy5jaGRpcihiYXNlKTtcblxuICB0cnkge1xuICAgIGNvbnN0IGN0eCA9IGNyZWF0ZU1vY2tDdHgoKTtcbiAgICBjb25zdCB7IGNhbGxzLCBwaSB9ID0gY3JlYXRlTW9ja1BpV2l0aERpc3BhdGNoKCk7XG5cbiAgICAvLyBDcmVhdGUgc2Vzc2lvbiBhbmQgc2V0IHRkZEdhdGUgdG8gcGVuZGluZ1xuICAgIGNvbnN0IGNyZWF0ZWQgPSBjcmVhdGVEZWJ1Z1Nlc3Npb24oYmFzZSwgeyBpc3N1ZTogXCJXaWRnZXQgc3RhdGUgcmVzZXRzIG9uIHJlLXJlbmRlclwiIH0pO1xuICAgIGNvbnN0IHNsdWcgPSBjcmVhdGVkLnNlc3Npb24uc2x1ZztcblxuICAgIHVwZGF0ZURlYnVnU2Vzc2lvbihiYXNlLCBzbHVnLCB7XG4gICAgICB0ZGRHYXRlOiB7IGVuYWJsZWQ6IHRydWUsIHBoYXNlOiBcInBlbmRpbmdcIiB9LFxuICAgIH0pO1xuXG4gICAgLy8gQ29udGludWUgd2l0aCBwZW5kaW5nOiBnb2FsID0gZmluZF9yb290X2NhdXNlX29ubHksIHRkZEdhdGUucGhhc2Ugc3RheXMgcGVuZGluZ1xuICAgIGF3YWl0IGhhbmRsZURlYnVnKGBjb250aW51ZSAke3NsdWd9YCwgY3R4IGFzIGFueSwgcGkgYXMgYW55KTtcbiAgICBjb25zdCBwZW5kaW5nTm90aWYgPSBsYXN0Tm90aWZpY2F0aW9uKGN0eCk7XG4gICAgYXNzZXJ0Lm1hdGNoKHBlbmRpbmdOb3RpZi5tZXNzYWdlLCAvZGlzcGF0Y2hNb2RlPXRkZFBoYXNlPXBlbmRpbmcvKTtcblxuICAgIGFzc2VydC5lcXVhbChjYWxscy5sZW5ndGgsIDEpO1xuICAgIGNvbnN0IHBlbmRpbmdDYWxsID0gY2FsbHNbMF07XG4gICAgYXNzZXJ0Lm1hdGNoKHBlbmRpbmdDYWxsLnBheWxvYWQuY29udGVudCwgLyMjIEdvYWxcXHMrYGZpbmRfcm9vdF9jYXVzZV9vbmx5YC8pO1xuICAgIGFzc2VydC5tYXRjaChwZW5kaW5nQ2FsbC5wYXlsb2FkLmNvbnRlbnQsIC9waGFzZTogcGVuZGluZy8pO1xuICAgIGFzc2VydC5tYXRjaChwZW5kaW5nQ2FsbC5wYXlsb2FkLmNvbnRlbnQsIC9TdHJ1Y3R1cmVkIFJldHVybiBQcm90b2NvbC8pO1xuXG4gICAgLy8gRGlzay1yZWxvYWQ6IHRkZEdhdGUucGhhc2UgbXVzdCByZW1haW4gcGVuZGluZyAocGVuZGluZyBkb2VzIG5vdCBhZHZhbmNlKVxuICAgIGNvbnN0IGFmdGVyUGVuZGluZyA9IGxvYWREZWJ1Z1Nlc3Npb24oYmFzZSwgc2x1Zyk7XG4gICAgYXNzZXJ0Lm9rKGFmdGVyUGVuZGluZywgXCJzZXNzaW9uIG11c3QgZXhpc3QgYWZ0ZXIgcGVuZGluZyBjb250aW51ZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoYWZ0ZXJQZW5kaW5nIS5zZXNzaW9uLnRkZEdhdGU/LnBoYXNlLCBcInBlbmRpbmdcIiwgXCJwZW5kaW5nIHBoYXNlIG11c3Qgbm90IGFkdmFuY2Ugb24gZGlza1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoYWZ0ZXJQZW5kaW5nIS5zZXNzaW9uLnBoYXNlLCBcImNvbnRpbnVlZFwiKTtcblxuICAgIC8vIEFkdmFuY2UgdG8gcmVkIHdpdGggdGVzdCBtZXRhZGF0YVxuICAgIHVwZGF0ZURlYnVnU2Vzc2lvbihiYXNlLCBzbHVnLCB7XG4gICAgICB0ZGRHYXRlOiB7IGVuYWJsZWQ6IHRydWUsIHBoYXNlOiBcInJlZFwiLCB0ZXN0RmlsZTogXCJ3aWRnZXQudGVzdC50c1wiLCB0ZXN0TmFtZTogXCJyZXNldHMgb24gcmUtcmVuZGVyXCIgfSxcbiAgICB9KTtcbiAgICBjYWxscy5sZW5ndGggPSAwO1xuXG4gICAgLy8gQ29udGludWUgd2l0aCByZWQ6IGdvYWwgPSBmaW5kX2FuZF9maXgsIHBoYXNlIGFkdmFuY2VzIHRvIGdyZWVuIG9uIGRpc2tcbiAgICBhd2FpdCBoYW5kbGVEZWJ1ZyhgY29udGludWUgJHtzbHVnfWAsIGN0eCBhcyBhbnksIHBpIGFzIGFueSk7XG4gICAgY29uc3QgcmVkTm90aWYgPSBsYXN0Tm90aWZpY2F0aW9uKGN0eCk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlZE5vdGlmLm1lc3NhZ2UsIC9kaXNwYXRjaE1vZGU9dGRkUGhhc2U9cmVkLyk7XG5cbiAgICBhc3NlcnQuZXF1YWwoY2FsbHMubGVuZ3RoLCAxKTtcbiAgICBjb25zdCByZWRDYWxsID0gY2FsbHNbMF07XG4gICAgYXNzZXJ0Lm1hdGNoKHJlZENhbGwucGF5bG9hZC5jb250ZW50LCAvIyMgR29hbFxccytgZmluZF9hbmRfZml4YC8pO1xuICAgIGFzc2VydC5tYXRjaChyZWRDYWxsLnBheWxvYWQuY29udGVudCwgL3BoYXNlOiByZWQvKTtcbiAgICBhc3NlcnQubWF0Y2gocmVkQ2FsbC5wYXlsb2FkLmNvbnRlbnQsIC90ZXN0RmlsZTogd2lkZ2V0XFwudGVzdFxcLnRzLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlZENhbGwucGF5bG9hZC5jb250ZW50LCAvdGVzdE5hbWU6IHJlc2V0cyBvbiByZS1yZW5kZXIvKTtcblxuICAgIC8vIERpc2stcmVsb2FkOiB0ZGRHYXRlLnBoYXNlIG11c3QgYWR2YW5jZSB0byBncmVlblxuICAgIGNvbnN0IGFmdGVyUmVkID0gbG9hZERlYnVnU2Vzc2lvbihiYXNlLCBzbHVnKTtcbiAgICBhc3NlcnQub2soYWZ0ZXJSZWQsIFwic2Vzc2lvbiBtdXN0IGV4aXN0IGFmdGVyIHJlZCBjb250aW51ZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoYWZ0ZXJSZWQhLnNlc3Npb24udGRkR2F0ZT8ucGhhc2UsIFwiZ3JlZW5cIiwgXCJ0ZGRHYXRlLnBoYXNlIG11c3QgYWR2YW5jZSByZWRcdTIxOTJncmVlbiBvbiBkaXNrXCIpO1xuICAgIGFzc2VydC5lcXVhbChhZnRlclJlZCEuc2Vzc2lvbi5waGFzZSwgXCJjb250aW51ZWRcIik7XG5cbiAgICBjYWxscy5sZW5ndGggPSAwO1xuXG4gICAgLy8gQ29udGludWUgd2l0aCBncmVlbjogZ29hbCA9IGZpbmRfYW5kX2ZpeCwgbm90aWZpY2F0aW9uIHNob3dzIHRkZFBoYXNlPWdyZWVuXG4gICAgYXdhaXQgaGFuZGxlRGVidWcoYGNvbnRpbnVlICR7c2x1Z31gLCBjdHggYXMgYW55LCBwaSBhcyBhbnkpO1xuICAgIGNvbnN0IGdyZWVuTm90aWYgPSBsYXN0Tm90aWZpY2F0aW9uKGN0eCk7XG4gICAgYXNzZXJ0Lm1hdGNoKGdyZWVuTm90aWYubWVzc2FnZSwgL2Rpc3BhdGNoTW9kZT10ZGRQaGFzZT1ncmVlbi8pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKGNhbGxzLmxlbmd0aCwgMSk7XG4gICAgY29uc3QgZ3JlZW5DYWxsID0gY2FsbHNbMF07XG4gICAgYXNzZXJ0Lm1hdGNoKGdyZWVuQ2FsbC5wYXlsb2FkLmNvbnRlbnQsIC8jIyBHb2FsXFxzK2BmaW5kX2FuZF9maXhgLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGdyZWVuQ2FsbC5wYXlsb2FkLmNvbnRlbnQsIC9waGFzZTogZ3JlZW4vKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBwcm9jZXNzLmNoZGlyKHNhdmVkKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcIi9nc2QgZGVidWcgUzA1OiBjb21iaW5lZCBjaGVja3BvaW50ICsgc3BlY2lhbGlzdCByZXZpZXcgKyBUREQgZ2F0ZSBcdTIwMTQgYWxsIHRocmVlIHNlY3Rpb25zIHByZXNlbnQgaW4gZGlzcGF0Y2ggcGF5bG9hZFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICBjb25zdCBzYXZlZCA9IHByb2Nlc3MuY3dkKCk7XG4gIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjdHggPSBjcmVhdGVNb2NrQ3R4KCk7XG4gICAgY29uc3QgeyBjYWxscywgcGkgfSA9IGNyZWF0ZU1vY2tQaVdpdGhEaXNwYXRjaCgpO1xuXG4gICAgY29uc3QgY3JlYXRlZCA9IGNyZWF0ZURlYnVnU2Vzc2lvbihiYXNlLCB7IGlzc3VlOiBcIldpZGdldCByZW5kZXIgbG9vcCBkZXRlY3RlZFwiIH0pO1xuICAgIGNvbnN0IHNsdWcgPSBjcmVhdGVkLnNlc3Npb24uc2x1ZztcblxuICAgIC8vIFNldCBhbGwgdGhyZWUgZW5yaWNobWVudCBmaWVsZHMgc2ltdWx0YW5lb3VzbHlcbiAgICB1cGRhdGVEZWJ1Z1Nlc3Npb24oYmFzZSwgc2x1Zywge1xuICAgICAgY2hlY2twb2ludDoge1xuICAgICAgICB0eXBlOiBcInJvb3QtY2F1c2UtZm91bmRcIixcbiAgICAgICAgc3VtbWFyeTogXCJDb25maXJtZWQgaW5maW5pdGUgcmUtcmVuZGVyIGR1ZSB0byB1bnN0YWJsZSByZWZlcmVuY2VcIixcbiAgICAgICAgYXdhaXRpbmdSZXNwb25zZTogdHJ1ZSxcbiAgICAgIH0sXG4gICAgICBzcGVjaWFsaXN0UmV2aWV3OiB7XG4gICAgICAgIGhpbnQ6IFwidHlwZXNjcmlwdFwiLFxuICAgICAgICBza2lsbDogXCJ0eXBlc2NyaXB0LWV4cGVydFwiLFxuICAgICAgICB2ZXJkaWN0OiBcIlNVR0dFU1RfQ0hBTkdFXCIsXG4gICAgICAgIGRldGFpbDogXCJVc2UgdXNlTWVtbyB0byBzdGFiaWxpemUgdGhlIHJlZmVyZW5jZVwiLFxuICAgICAgICByZXZpZXdlZEF0OiAxNzAwMDAwMDAyMDAwLFxuICAgICAgfSxcbiAgICAgIHRkZEdhdGU6IHtcbiAgICAgICAgZW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgcGhhc2U6IFwicmVkXCIsXG4gICAgICAgIHRlc3RGaWxlOiBcIndpZGdldC50ZXN0LnRzXCIsXG4gICAgICAgIHRlc3ROYW1lOiBcImRvZXMgbm90IGxvb3Agb24gc3RhYmxlIHByb3BzXCIsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgYXdhaXQgaGFuZGxlRGVidWcoYGNvbnRpbnVlICR7c2x1Z31gLCBjdHggYXMgYW55LCBwaSBhcyBhbnkpO1xuXG4gICAgY29uc3QgbiA9IGxhc3ROb3RpZmljYXRpb24oY3R4KTtcbiAgICBhc3NlcnQuZXF1YWwobi5sZXZlbCwgXCJpbmZvXCIpO1xuICAgIGFzc2VydC5tYXRjaChuLm1lc3NhZ2UsIG5ldyBSZWdFeHAoYFJlc3VtZWQgZGVidWcgc2Vzc2lvbjogJHtzbHVnfWApKTtcbiAgICBhc3NlcnQubWF0Y2gobi5tZXNzYWdlLCAvcGhhc2U9Y29udGludWVkLyk7XG4gICAgLy8gTm90aWZpY2F0aW9uIG11c3QgY2FycnkgYm90aCB0ZGRQaGFzZSBhbmQgc3BlY2lhbGlzdEhpbnQgbGFiZWxzXG4gICAgYXNzZXJ0Lm1hdGNoKG4ubWVzc2FnZSwgL3NwZWNpYWxpc3RIaW50PXR5cGVzY3JpcHQvKTtcbiAgICBhc3NlcnQubWF0Y2gobi5tZXNzYWdlLCAvdGRkUGhhc2U9cmVkLyk7XG5cbiAgICBhc3NlcnQuZXF1YWwoY2FsbHMubGVuZ3RoLCAxLCBcInNob3VsZCBkaXNwYXRjaCBleGFjdGx5IG9uZSBtZXNzYWdlXCIpO1xuICAgIGNvbnN0IGNhbGwgPSBjYWxsc1swXTtcbiAgICBhc3NlcnQuZXF1YWwoY2FsbC5wYXlsb2FkLmN1c3RvbVR5cGUsIFwiZ3NkLWRlYnVnLWNvbnRpbnVlXCIpO1xuICAgIC8vIGRlYnVnLXNlc3Npb24tbWFuYWdlciB0ZW1wbGF0ZSBtYXJrZXJcbiAgICBhc3NlcnQubWF0Y2goY2FsbC5wYXlsb2FkLmNvbnRlbnQsIC9TdHJ1Y3R1cmVkIFJldHVybiBQcm90b2NvbC8pO1xuICAgIC8vIEFjdGl2ZSBDaGVja3BvaW50IHNlY3Rpb25cbiAgICBhc3NlcnQubWF0Y2goY2FsbC5wYXlsb2FkLmNvbnRlbnQsIC8jIyBBY3RpdmUgQ2hlY2twb2ludC8pO1xuICAgIGFzc2VydC5tYXRjaChjYWxsLnBheWxvYWQuY29udGVudCwgL3R5cGU6IHJvb3QtY2F1c2UtZm91bmQvKTtcbiAgICAvLyBQcmlvciBTcGVjaWFsaXN0IFJldmlldyBzZWN0aW9uIChoZWFkaW5nLCBub3QgY29udGVudCB2YWx1ZXMpXG4gICAgYXNzZXJ0Lm1hdGNoKGNhbGwucGF5bG9hZC5jb250ZW50LCAvUHJpb3IgU3BlY2lhbGlzdCBSZXZpZXcvKTtcbiAgICBhc3NlcnQubWF0Y2goY2FsbC5wYXlsb2FkLmNvbnRlbnQsIC9oaW50OiB0eXBlc2NyaXB0Lyk7XG4gICAgLy8gVEREIEdhdGUgc2VjdGlvblxuICAgIGFzc2VydC5tYXRjaChjYWxsLnBheWxvYWQuY29udGVudCwgLyMjIFRERCBHYXRlLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGNhbGwucGF5bG9hZC5jb250ZW50LCAvcGhhc2U6IHJlZC8pO1xuICAgIGFzc2VydC5tYXRjaChjYWxsLnBheWxvYWQuY29udGVudCwgL3Rlc3RGaWxlOiB3aWRnZXRcXC50ZXN0XFwudHMvKTtcbiAgICBhc3NlcnQuZXF1YWwoY2FsbC5vcHRpb25zLnRyaWdnZXJUdXJuLCB0cnVlKTtcblxuICAgIC8vIERpc2stcmVsb2FkOiB0ZGRHYXRlLnBoYXNlIG11c3QgYWR2YW5jZSByZWRcdTIxOTJncmVlblxuICAgIGNvbnN0IHJlbG9hZGVkID0gbG9hZERlYnVnU2Vzc2lvbihiYXNlLCBzbHVnKTtcbiAgICBhc3NlcnQub2socmVsb2FkZWQsIFwic2Vzc2lvbiBtdXN0IGV4aXN0IGFmdGVyIGNvbWJpbmVkIGNvbnRpbnVlXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZWxvYWRlZCEuc2Vzc2lvbi50ZGRHYXRlPy5waGFzZSwgXCJncmVlblwiLCBcInRkZEdhdGUucGhhc2UgbXVzdCBhZHZhbmNlIHJlZFx1MjE5MmdyZWVuIG9uIGRpc2tcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlbG9hZGVkIS5zZXNzaW9uLnBoYXNlLCBcImNvbnRpbnVlZFwiKTtcbiAgICAvLyBzcGVjaWFsaXN0UmV2aWV3IG11c3QgYmUgcHJlc2VydmVkXG4gICAgYXNzZXJ0Lm9rKHJlbG9hZGVkIS5zZXNzaW9uLnNwZWNpYWxpc3RSZXZpZXcgIT0gbnVsbCwgXCJzcGVjaWFsaXN0UmV2aWV3IG11c3QgYmUgcHJlc2VydmVkIGFmdGVyIGNvbnRpbnVlXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZWxvYWRlZCEuc2Vzc2lvbi5zcGVjaWFsaXN0UmV2aWV3IS5oaW50LCBcInR5cGVzY3JpcHRcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcHJvY2Vzcy5jaGRpcihzYXZlZCk7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCIvZ3NkIGRlYnVnIFMwNTogbXVsdGktc2Vzc2lvbiBjb25jdXJyZW50IGxpZmVjeWNsZSBcdTIwMTQgMyBzZXNzaW9ucyBjb250aW51ZSBpbmRlcGVuZGVudGx5IGFuZCBsaXN0IHNob3dzIGFsbCBhcyBjb250aW51ZWRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmN3ZCgpO1xuICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuXG4gICAgLy8gU3RhcnQgMyBzZXNzaW9ucyB2aWEgaGFuZGxlR1NEQ29tbWFuZFxuICAgIGF3YWl0IGhhbmRsZUdTRENvbW1hbmQoXCJkZWJ1ZyBBdXRoIHRva2VuIGV4cGlyZXMgc2lsZW50bHlcIiwgY3R4IGFzIGFueSwge30gYXMgYW55KTtcbiAgICBhc3NlcnQubWF0Y2gobGFzdE5vdGlmaWNhdGlvbihjdHgpLm1lc3NhZ2UsIC9EZWJ1ZyBzZXNzaW9uIHN0YXJ0ZWQ6IGF1dGgtdG9rZW4tZXhwaXJlcy1zaWxlbnRseS8pO1xuXG4gICAgYXdhaXQgaGFuZGxlR1NEQ29tbWFuZChcImRlYnVnIENhY2hlIG1pc3NlcyBvbiBjb2xkIHN0YXJ0XCIsIGN0eCBhcyBhbnksIHt9IGFzIGFueSk7XG4gICAgYXNzZXJ0Lm1hdGNoKGxhc3ROb3RpZmljYXRpb24oY3R4KS5tZXNzYWdlLCAvRGVidWcgc2Vzc2lvbiBzdGFydGVkOiBjYWNoZS1taXNzZXMtb24tY29sZC1zdGFydC8pO1xuXG4gICAgYXdhaXQgaGFuZGxlR1NEQ29tbWFuZChcImRlYnVnIFBheW1lbnQgd2ViaG9vayBkcm9wcyB1bmRlciBsb2FkXCIsIGN0eCBhcyBhbnksIHt9IGFzIGFueSk7XG4gICAgYXNzZXJ0Lm1hdGNoKGxhc3ROb3RpZmljYXRpb24oY3R4KS5tZXNzYWdlLCAvRGVidWcgc2Vzc2lvbiBzdGFydGVkOiBwYXltZW50LXdlYmhvb2stZHJvcHMtdW5kZXItbG9hZC8pO1xuXG4gICAgLy8gQ29udGludWUgZWFjaCBzZXNzaW9uIHNlcGFyYXRlbHkgd2l0aCBpdHMgb3duIGRpc3BhdGNoIG1vY2tcbiAgICBjb25zdCB7IGNhbGxzOiBjYWxsczEsIHBpOiBwaTEgfSA9IGNyZWF0ZU1vY2tQaVdpdGhEaXNwYXRjaCgpO1xuICAgIGF3YWl0IGhhbmRsZURlYnVnKFwiY29udGludWUgYXV0aC10b2tlbi1leHBpcmVzLXNpbGVudGx5XCIsIGN0eCBhcyBhbnksIHBpMSBhcyBhbnkpO1xuICAgIGFzc2VydC5lcXVhbChjYWxsczEubGVuZ3RoLCAxLCBcInNlc3Npb24gMSBzaG91bGQgZGlzcGF0Y2ggZXhhY3RseSBvbmUgbWVzc2FnZVwiKTtcbiAgICAvLyBDb250ZW50IG11c3QgcmVmZXJlbmNlIHNlc3Npb24gMSdzIHNsdWcsIG5vdCB0aGUgb3RoZXJzXG4gICAgYXNzZXJ0Lm1hdGNoKGNhbGxzMVswXS5wYXlsb2FkLmNvbnRlbnQsIC9hdXRoLXRva2VuLWV4cGlyZXMtc2lsZW50bHkvKTtcbiAgICBhc3NlcnQuZG9lc05vdE1hdGNoKGNhbGxzMVswXS5wYXlsb2FkLmNvbnRlbnQsIC9jYWNoZS1taXNzZXMtb24tY29sZC1zdGFydC8pO1xuICAgIGFzc2VydC5kb2VzTm90TWF0Y2goY2FsbHMxWzBdLnBheWxvYWQuY29udGVudCwgL3BheW1lbnQtd2ViaG9vay1kcm9wcy11bmRlci1sb2FkLyk7XG5cbiAgICBjb25zdCB7IGNhbGxzOiBjYWxsczIsIHBpOiBwaTIgfSA9IGNyZWF0ZU1vY2tQaVdpdGhEaXNwYXRjaCgpO1xuICAgIGF3YWl0IGhhbmRsZURlYnVnKFwiY29udGludWUgY2FjaGUtbWlzc2VzLW9uLWNvbGQtc3RhcnRcIiwgY3R4IGFzIGFueSwgcGkyIGFzIGFueSk7XG4gICAgYXNzZXJ0LmVxdWFsKGNhbGxzMi5sZW5ndGgsIDEsIFwic2Vzc2lvbiAyIHNob3VsZCBkaXNwYXRjaCBleGFjdGx5IG9uZSBtZXNzYWdlXCIpO1xuICAgIGFzc2VydC5tYXRjaChjYWxsczJbMF0ucGF5bG9hZC5jb250ZW50LCAvY2FjaGUtbWlzc2VzLW9uLWNvbGQtc3RhcnQvKTtcbiAgICBhc3NlcnQuZG9lc05vdE1hdGNoKGNhbGxzMlswXS5wYXlsb2FkLmNvbnRlbnQsIC9hdXRoLXRva2VuLWV4cGlyZXMtc2lsZW50bHkvKTtcblxuICAgIGNvbnN0IHsgY2FsbHM6IGNhbGxzMywgcGk6IHBpMyB9ID0gY3JlYXRlTW9ja1BpV2l0aERpc3BhdGNoKCk7XG4gICAgYXdhaXQgaGFuZGxlRGVidWcoXCJjb250aW51ZSBwYXltZW50LXdlYmhvb2stZHJvcHMtdW5kZXItbG9hZFwiLCBjdHggYXMgYW55LCBwaTMgYXMgYW55KTtcbiAgICBhc3NlcnQuZXF1YWwoY2FsbHMzLmxlbmd0aCwgMSwgXCJzZXNzaW9uIDMgc2hvdWxkIGRpc3BhdGNoIGV4YWN0bHkgb25lIG1lc3NhZ2VcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKGNhbGxzM1swXS5wYXlsb2FkLmNvbnRlbnQsIC9wYXltZW50LXdlYmhvb2stZHJvcHMtdW5kZXItbG9hZC8pO1xuICAgIGFzc2VydC5kb2VzTm90TWF0Y2goY2FsbHMzWzBdLnBheWxvYWQuY29udGVudCwgL2F1dGgtdG9rZW4tZXhwaXJlcy1zaWxlbnRseS8pO1xuXG4gICAgLy8gZGVidWcgbGlzdCBtdXN0IHNob3cgYWxsIDMgYXMgcGhhc2U9Y29udGludWVkXG4gICAgYXdhaXQgaGFuZGxlR1NEQ29tbWFuZChcImRlYnVnIGxpc3RcIiwgY3R4IGFzIGFueSwge30gYXMgYW55KTtcbiAgICBjb25zdCBsaXN0ZWQgPSBsYXN0Tm90aWZpY2F0aW9uKGN0eCk7XG4gICAgYXNzZXJ0LmVxdWFsKGxpc3RlZC5sZXZlbCwgXCJpbmZvXCIpO1xuICAgIGFzc2VydC5tYXRjaChsaXN0ZWQubWVzc2FnZSwgL2F1dGgtdG9rZW4tZXhwaXJlcy1zaWxlbnRseS8pO1xuICAgIGFzc2VydC5tYXRjaChsaXN0ZWQubWVzc2FnZSwgL2NhY2hlLW1pc3Nlcy1vbi1jb2xkLXN0YXJ0Lyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGxpc3RlZC5tZXNzYWdlLCAvcGF5bWVudC13ZWJob29rLWRyb3BzLXVuZGVyLWxvYWQvKTtcbiAgICBhc3NlcnQubWF0Y2gobGlzdGVkLm1lc3NhZ2UsIC9waGFzZT1jb250aW51ZWQvKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBwcm9jZXNzLmNoZGlyKHNhdmVkKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcIi9nc2QgZGVidWcgUzA1OiByZXNvbHZlZCBzZXNzaW9uIGJsb2NrcyBjb250aW51ZSB2aWEgZGlzcGF0Y2hlciByb3V0ZSBcdTIwMTQgd2FybmluZyBlbWl0dGVkLCB6ZXJvIGRpc3BhdGNoZXNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmN3ZCgpO1xuICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuICAgIGNvbnN0IHsgY2FsbHMsIHBpIH0gPSBjcmVhdGVNb2NrUGlXaXRoRGlzcGF0Y2goKTtcblxuICAgIC8vIFN0YXJ0IHNlc3Npb24gdmlhIGhhbmRsZUdTRENvbW1hbmQgKGRpc3BhdGNoZXIgcm91dGUpXG4gICAgYXdhaXQgaGFuZGxlR1NEQ29tbWFuZChcImRlYnVnIFN0YWxlIGxvY2sgZmlsZSBibG9ja3MgZGVwbG95XCIsIGN0eCBhcyBhbnksIHt9IGFzIGFueSk7XG4gICAgY29uc3Qgc3RhcnRlZCA9IGxhc3ROb3RpZmljYXRpb24oY3R4KTtcbiAgICBhc3NlcnQuZXF1YWwoc3RhcnRlZC5sZXZlbCwgXCJpbmZvXCIpO1xuICAgIGFzc2VydC5tYXRjaChzdGFydGVkLm1lc3NhZ2UsIC9EZWJ1ZyBzZXNzaW9uIHN0YXJ0ZWQ6IHN0YWxlLWxvY2stZmlsZS1ibG9ja3MtZGVwbG95Lyk7XG4gICAgY29uc3Qgc2x1ZyA9IFwic3RhbGUtbG9jay1maWxlLWJsb2Nrcy1kZXBsb3lcIjtcblxuICAgIC8vIE1hcmsgYXMgcmVzb2x2ZWQgdmlhIHN0b3JlIEFQSVxuICAgIHVwZGF0ZURlYnVnU2Vzc2lvbihiYXNlLCBzbHVnLCB7IHN0YXR1czogXCJyZXNvbHZlZFwiIH0pO1xuXG4gICAgLy8gQXR0ZW1wdCBjb250aW51ZSB2aWEgZGlzcGF0Y2hlciByb3V0ZSAoaGFuZGxlR1NEQ29tbWFuZCwgbm90IGhhbmRsZURlYnVnIGRpcmVjdGx5KVxuICAgIGF3YWl0IGhhbmRsZUdTRENvbW1hbmQoYGRlYnVnIGNvbnRpbnVlICR7c2x1Z31gLCBjdHggYXMgYW55LCBwaSBhcyBhbnkpO1xuXG4gICAgY29uc3Qgd2FybmVkID0gbGFzdE5vdGlmaWNhdGlvbihjdHgpO1xuICAgIGFzc2VydC5lcXVhbCh3YXJuZWQubGV2ZWwsIFwid2FybmluZ1wiKTtcbiAgICBhc3NlcnQubWF0Y2god2FybmVkLm1lc3NhZ2UsIG5ldyBSZWdFeHAoYFNlc3Npb24gJyR7c2x1Z30nIGlzIHJlc29sdmVkYCkpO1xuICAgIC8vIFplcm8gZGlzcGF0Y2ggY2FsbHMgXHUyMDE0IGd1YXJkIG11c3QgZmlyZSBiZWZvcmUgc2VuZE1lc3NhZ2VcbiAgICBhc3NlcnQuZXF1YWwoY2FsbHMubGVuZ3RoLCAwLCBcIm5vIGRpc3BhdGNoIGZvciByZXNvbHZlZCBzZXNzaW9uIHZpYSBkaXNwYXRjaGVyIHJvdXRlXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHByb2Nlc3MuY2hkaXIoc2F2ZWQpO1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiL2dzZCBkZWJ1ZyBTMDU6IFRERCBnYXRlIGdyZWVuLXBoYXNlIGNvbnRpbnVlIGRpc3BhdGNoZXMgZmluZF9hbmRfZml4IHdpdGggZ3JlZW4gY29udGV4dCBhbmQgJ3Rlc3QgaXMgbm93IHBhc3NpbmcnIHRleHRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmN3ZCgpO1xuICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuICAgIGNvbnN0IHsgY2FsbHMsIHBpIH0gPSBjcmVhdGVNb2NrUGlXaXRoRGlzcGF0Y2goKTtcblxuICAgIGNvbnN0IGNyZWF0ZWQgPSBjcmVhdGVEZWJ1Z1Nlc3Npb24oYmFzZSwgeyBpc3N1ZTogXCJCdXR0b24gY2xpY2sgaGFuZGxlciBmaXJlcyB0d2ljZVwiIH0pO1xuICAgIGNvbnN0IHNsdWcgPSBjcmVhdGVkLnNlc3Npb24uc2x1ZztcblxuICAgIC8vIFNldCB0ZGRHYXRlIGRpcmVjdGx5IHRvIGdyZWVuIChzaW11bGF0aW5nIHRoYXQgcmVkIHBoYXNlIHdhcyBhbHJlYWR5IGNvbXBsZXRlZClcbiAgICB1cGRhdGVEZWJ1Z1Nlc3Npb24oYmFzZSwgc2x1Zywge1xuICAgICAgdGRkR2F0ZToge1xuICAgICAgICBlbmFibGVkOiB0cnVlLFxuICAgICAgICBwaGFzZTogXCJncmVlblwiLFxuICAgICAgICB0ZXN0RmlsZTogXCJidXR0b24udGVzdC50c1wiLFxuICAgICAgICB0ZXN0TmFtZTogXCJmaXJlcyBoYW5kbGVyIG9uY2UgcGVyIGNsaWNrXCIsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgYXdhaXQgaGFuZGxlRGVidWcoYGNvbnRpbnVlICR7c2x1Z31gLCBjdHggYXMgYW55LCBwaSBhcyBhbnkpO1xuXG4gICAgY29uc3QgbiA9IGxhc3ROb3RpZmljYXRpb24oY3R4KTtcbiAgICBhc3NlcnQuZXF1YWwobi5sZXZlbCwgXCJpbmZvXCIpO1xuICAgIGFzc2VydC5tYXRjaChuLm1lc3NhZ2UsIG5ldyBSZWdFeHAoYFJlc3VtZWQgZGVidWcgc2Vzc2lvbjogJHtzbHVnfWApKTtcbiAgICBhc3NlcnQubWF0Y2gobi5tZXNzYWdlLCAvcGhhc2U9Y29udGludWVkLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKG4ubWVzc2FnZSwgL2Rpc3BhdGNoTW9kZT10ZGRQaGFzZT1ncmVlbi8pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKGNhbGxzLmxlbmd0aCwgMSwgXCJzaG91bGQgZGlzcGF0Y2ggZXhhY3RseSBvbmUgbWVzc2FnZVwiKTtcbiAgICBjb25zdCBjYWxsID0gY2FsbHNbMF07XG4gICAgYXNzZXJ0LmVxdWFsKGNhbGwucGF5bG9hZC5jdXN0b21UeXBlLCBcImdzZC1kZWJ1Zy1jb250aW51ZVwiKTtcbiAgICAvLyBmaW5kX2FuZF9maXggZ29hbCBmb3IgZ3JlZW4gcGhhc2VcbiAgICBhc3NlcnQubWF0Y2goY2FsbC5wYXlsb2FkLmNvbnRlbnQsIC8jIyBHb2FsXFxzK2BmaW5kX2FuZF9maXhgLyk7XG4gICAgLy8gVEREIEdhdGUgc2VjdGlvbiB3aXRoIGdyZWVuIHBoYXNlXG4gICAgYXNzZXJ0Lm1hdGNoKGNhbGwucGF5bG9hZC5jb250ZW50LCAvIyMgVEREIEdhdGUvKTtcbiAgICBhc3NlcnQubWF0Y2goY2FsbC5wYXlsb2FkLmNvbnRlbnQsIC9waGFzZTogZ3JlZW4vKTtcbiAgICAvLyBcIlRoZSB0ZXN0IGlzIG5vdyBwYXNzaW5nXCIgdGV4dCBlbWl0dGVkIGJ5IHRoZSBoYW5kbGVyIGZvciBncmVlbiBwaGFzZVxuICAgIGFzc2VydC5tYXRjaChjYWxsLnBheWxvYWQuY29udGVudCwgL1RoZSB0ZXN0IGlzIG5vdyBwYXNzaW5nLyk7XG4gICAgLy8gdGVzdCBtZXRhZGF0YSBwcmVzZW50XG4gICAgYXNzZXJ0Lm1hdGNoKGNhbGwucGF5bG9hZC5jb250ZW50LCAvdGVzdEZpbGU6IGJ1dHRvblxcLnRlc3RcXC50cy8pO1xuICAgIGFzc2VydC5tYXRjaChjYWxsLnBheWxvYWQuY29udGVudCwgL3Rlc3ROYW1lOiBmaXJlcyBoYW5kbGVyIG9uY2UgcGVyIGNsaWNrLyk7XG4gICAgYXNzZXJ0LmVxdWFsKGNhbGwub3B0aW9ucy50cmlnZ2VyVHVybiwgdHJ1ZSk7XG5cbiAgICAvLyBEaXNrLXJlbG9hZDogc2Vzc2lvbiBwZXJzaXN0ZWQgY29ycmVjdGx5XG4gICAgY29uc3QgcmVsb2FkZWQgPSBsb2FkRGVidWdTZXNzaW9uKGJhc2UsIHNsdWcpO1xuICAgIGFzc2VydC5vayhyZWxvYWRlZCwgXCJzZXNzaW9uIG11c3QgZXhpc3QgYWZ0ZXIgZ3JlZW4gY29udGludWVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlbG9hZGVkIS5zZXNzaW9uLnBoYXNlLCBcImNvbnRpbnVlZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVsb2FkZWQhLnNlc3Npb24udGRkR2F0ZT8ucGhhc2UsIFwiZ3JlZW5cIiwgXCJncmVlbiBwaGFzZSBtdXN0IHJlbWFpbiBncmVlbiAobm8gZnVydGhlciBhZHZhbmNlKVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBwcm9jZXNzLmNoZGlyKHNhdmVkKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcIi9nc2QgZGVidWcgUzA1OiBkaXNwYXRjaCBmYWlsdXJlIHJlc2lsaWVuY2UgXHUyMDE0IHNlbmRNZXNzYWdlIHRocm93cywgc2Vzc2lvbiByZW1haW5zIHJlc3VtYWJsZSBhbmQgcmV0cnkgc3VjY2VlZHNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmN3ZCgpO1xuICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY3R4ID0gY3JlYXRlTW9ja0N0eCgpO1xuXG4gICAgLy8gQ3JlYXRlIHNlc3Npb24gd2l0aCBjaGVja3BvaW50IHRvIGVuZ2FnZSBkZWJ1Zy1zZXNzaW9uLW1hbmFnZXIgdGVtcGxhdGVcbiAgICBjb25zdCBjcmVhdGVkID0gY3JlYXRlRGVidWdTZXNzaW9uKGJhc2UsIHsgaXNzdWU6IFwiUGF5bWVudCBwcm9jZXNzb3IgdGltZW91dCBvbiByZXRyeVwiIH0pO1xuICAgIGNvbnN0IHNsdWcgPSBjcmVhdGVkLnNlc3Npb24uc2x1ZztcblxuICAgIHVwZGF0ZURlYnVnU2Vzc2lvbihiYXNlLCBzbHVnLCB7XG4gICAgICBjaGVja3BvaW50OiB7XG4gICAgICAgIHR5cGU6IFwiaHVtYW4tdmVyaWZ5XCIsXG4gICAgICAgIHN1bW1hcnk6IFwiQ29uZmlybSByZXRyeSBsb2dpYyB0ZXJtaW5hdGVzXCIsXG4gICAgICAgIGF3YWl0aW5nUmVzcG9uc2U6IHRydWUsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gTW9jayBwaSB3aG9zZSBzZW5kTWVzc2FnZSBhbHdheXMgdGhyb3dzXG4gICAgY29uc3QgdGhyb3dpbmdQaSA9IHtcbiAgICAgIHNlbmRNZXNzYWdlKF9wYXlsb2FkOiBhbnksIF9vcHRpb25zOiBhbnkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTmV0d29yayBlcnJvcjogc2VuZE1lc3NhZ2UgZmFpbGVkXCIpO1xuICAgICAgfSxcbiAgICB9O1xuXG4gICAgYXdhaXQgaGFuZGxlRGVidWcoYGNvbnRpbnVlICR7c2x1Z31gLCBjdHggYXMgYW55LCB0aHJvd2luZ1BpIGFzIGFueSk7XG5cbiAgICAvLyBXYXJuaW5nIG5vdGlmaWNhdGlvbiBhYm91dCBkaXNwYXRjaCBmYWlsdXJlIChlbWl0dGVkIGFmdGVyIHRoZSBzZXNzaW9uLXVwZGF0ZSBpbmZvIG5vdGlmaWNhdGlvbilcbiAgICBjb25zdCBmYWlsTm90aWYgPSBsYXN0Tm90aWZpY2F0aW9uKGN0eCk7XG4gICAgYXNzZXJ0LmVxdWFsKGZhaWxOb3RpZi5sZXZlbCwgXCJ3YXJuaW5nXCIpO1xuICAgIGFzc2VydC5tYXRjaChmYWlsTm90aWYubWVzc2FnZSwgL0NvbnRpbnVlIGRpc3BhdGNoIGZhaWxlZC8pO1xuICAgIGFzc2VydC5tYXRjaChmYWlsTm90aWYubWVzc2FnZSwgbmV3IFJlZ0V4cChzbHVnKSk7XG5cbiAgICAvLyBTZXNzaW9uIG11c3QgYmUgcGVyc2lzdGVkIHdpdGggcGhhc2U9Y29udGludWVkIChzdGF0ZSBpcyB1cGRhdGVkIGJlZm9yZSBkaXNwYXRjaCBhdHRlbXB0KVxuICAgIGNvbnN0IHJlbG9hZGVkID0gbG9hZERlYnVnU2Vzc2lvbihiYXNlLCBzbHVnKTtcbiAgICBhc3NlcnQub2socmVsb2FkZWQsIFwic2Vzc2lvbiBtdXN0IHN0aWxsIGV4aXN0IG9uIGRpc2sgYWZ0ZXIgZGlzcGF0Y2ggZmFpbHVyZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVsb2FkZWQhLnNlc3Npb24ucGhhc2UsIFwiY29udGludWVkXCIsIFwicGhhc2UgbXVzdCBiZSBjb250aW51ZWQgZGVzcGl0ZSBmYWlsZWQgZGlzcGF0Y2hcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlbG9hZGVkIS5zZXNzaW9uLnN0YXR1cywgXCJhY3RpdmVcIik7XG5cbiAgICAvLyBSZXRyeSB3aXRoIGEgd29ya2luZyBtb2NrIHBpIHN1Y2NlZWRzXG4gICAgY29uc3QgeyBjYWxsczogcmV0cnlDYWxscywgcGk6IHdvcmtpbmdQaSB9ID0gY3JlYXRlTW9ja1BpV2l0aERpc3BhdGNoKCk7XG4gICAgYXdhaXQgaGFuZGxlRGVidWcoYGNvbnRpbnVlICR7c2x1Z31gLCBjdHggYXMgYW55LCB3b3JraW5nUGkgYXMgYW55KTtcblxuICAgIGNvbnN0IHJldHJ5Tm90aWYgPSBsYXN0Tm90aWZpY2F0aW9uKGN0eCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJldHJ5Tm90aWYubGV2ZWwsIFwiaW5mb1wiKTtcbiAgICBhc3NlcnQubWF0Y2gocmV0cnlOb3RpZi5tZXNzYWdlLCBuZXcgUmVnRXhwKGBSZXN1bWVkIGRlYnVnIHNlc3Npb246ICR7c2x1Z31gKSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmV0cnlDYWxscy5sZW5ndGgsIDEsIFwicmV0cnkgc2hvdWxkIGRpc3BhdGNoIGV4YWN0bHkgb25lIG1lc3NhZ2VcIik7XG4gICAgY29uc3QgcmV0cnlDYWxsID0gcmV0cnlDYWxsc1swXTtcbiAgICBhc3NlcnQuZXF1YWwocmV0cnlDYWxsLnBheWxvYWQuY3VzdG9tVHlwZSwgXCJnc2QtZGVidWctY29udGludWVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJldHJ5Q2FsbC5vcHRpb25zLnRyaWdnZXJUdXJuLCB0cnVlKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBwcm9jZXNzLmNoZGlyKHNhdmVkKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxZQUFZLGFBQWEsV0FBVyxhQUFhLFFBQVEscUJBQXFCO0FBQ3ZGLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUyx3QkFBd0I7QUFDakMsU0FBUyxtQkFBbUI7QUFDNUI7QUFBQSxFQUNFO0FBQUEsRUFD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
