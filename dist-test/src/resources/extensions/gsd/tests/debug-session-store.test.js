import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertValidDebugSessionSlug,
  createDebugSession,
  debugSessionArtifactPath,
  debugSessionsDir,
  listDebugSessions,
  loadDebugSession,
  slugifyDebugSessionIssue,
  updateDebugSession
} from "../debug-session-store.js";
function makeBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-debug-session-store-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}
describe("debug-session-store: create/list/load/update", () => {
  test("creates first session under .gsd/debug/sessions with deterministic metadata", () => {
    const base = makeBase();
    try {
      const created = createDebugSession(base, {
        issue: "Login fails on Safari",
        createdAt: 1e3
      });
      assert.equal(created.session.slug, "login-fails-on-safari");
      assert.ok(created.artifactPath.includes(join(".gsd", "debug", "sessions")));
      assert.ok(created.artifactPath.endsWith("login-fails-on-safari.json"));
      assert.ok(created.session.logPath.includes(join(".gsd", "debug")));
      assert.ok(!created.session.logPath.includes(join("debug", "sessions")));
      assert.equal(created.session.status, "active");
      assert.equal(created.session.phase, "queued");
      assert.equal(created.session.createdAt, 1e3);
      assert.equal(created.session.updatedAt, 1e3);
      assert.ok(existsSync(created.artifactPath), "session artifact should exist");
      const raw = readFileSync(created.artifactPath, "utf-8");
      assert.ok(raw.includes('"slug": "login-fails-on-safari"'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("collision-safe slugging allows multiple same-title sessions", () => {
    const base = makeBase();
    try {
      const a = createDebugSession(base, { issue: "Auth issue" });
      const b = createDebugSession(base, { issue: "Auth issue" });
      const c = createDebugSession(base, { issue: "Auth issue" });
      assert.equal(a.session.slug, "auth-issue");
      assert.equal(b.session.slug, "auth-issue-2");
      assert.equal(c.session.slug, "auth-issue-3");
      assert.ok(existsSync(debugSessionArtifactPath(base, "auth-issue")));
      assert.ok(existsSync(debugSessionArtifactPath(base, "auth-issue-2")));
      assert.ok(existsSync(debugSessionArtifactPath(base, "auth-issue-3")));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("list returns deterministic ordering by updatedAt desc then slug", () => {
    const base = makeBase();
    try {
      createDebugSession(base, { issue: "First", createdAt: 100 });
      createDebugSession(base, { issue: "Second", createdAt: 200 });
      createDebugSession(base, { issue: "Third", createdAt: 300 });
      updateDebugSession(base, "first", { phase: "triage", updatedAt: 500 });
      const listed = listDebugSessions(base);
      assert.equal(listed.malformed.length, 0);
      assert.deepEqual(
        listed.sessions.map((s) => s.session.slug),
        ["first", "third", "second"]
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("load returns null when slug does not exist", () => {
    const base = makeBase();
    try {
      const loaded = loadDebugSession(base, "missing-slug");
      assert.equal(loaded, null);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("update persists status/phase/error metadata for observability", () => {
    const base = makeBase();
    try {
      createDebugSession(base, { issue: "Rate limit flake", createdAt: 10 });
      const updated = updateDebugSession(base, "rate-limit-flake", {
        status: "failed",
        phase: "diagnosing",
        lastError: "Timeout waiting for health check",
        updatedAt: 42
      });
      assert.equal(updated.session.status, "failed");
      assert.equal(updated.session.phase, "diagnosing");
      assert.equal(updated.session.lastError, "Timeout waiting for health check");
      assert.equal(updated.session.updatedAt, 42);
      const listed = listDebugSessions(base);
      assert.equal(listed.sessions[0].session.status, "failed");
      assert.equal(listed.sessions[0].session.phase, "diagnosing");
      assert.equal(listed.sessions[0].session.updatedAt, 42);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
describe("debug-session-store: malformed artifacts + negative paths", () => {
  test("list continues healthy sessions while surfacing malformed artifact paths", () => {
    const base = makeBase();
    try {
      createDebugSession(base, { issue: "Healthy issue", createdAt: 1 });
      const sessionsPath = debugSessionsDir(base);
      writeFileSync(join(sessionsPath, "corrupt.json"), "{ this is not json", "utf-8");
      const listed = listDebugSessions(base);
      assert.equal(listed.sessions.length, 1);
      assert.equal(listed.sessions[0].session.slug, "healthy-issue");
      assert.equal(listed.malformed.length, 1);
      assert.ok(listed.malformed[0].artifactPath.endsWith(join("sessions", "corrupt.json")));
      assert.match(listed.malformed[0].message, /parse debug session artifact/i);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("rejects empty issue text and unsupported tokens that slugify to empty", () => {
    const base = makeBase();
    try {
      assert.throws(
        () => createDebugSession(base, { issue: "   " }),
        /Issue text is required/i
      );
      assert.throws(
        () => slugifyDebugSessionIssue("\u{1F525}\u{1F525}\u{1F525}"),
        /alphanumeric/i
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("slugify normalizes unsupported characters into deterministic tokens", () => {
    assert.equal(
      slugifyDebugSessionIssue(" API / login \u{1F6A8} flaky  "),
      "api-login-flaky"
    );
  });
  test("invalid slug tokens are rejected for load/path validation", () => {
    const base = makeBase();
    try {
      assert.throws(() => assertValidDebugSessionSlug("../escape"), /Invalid debug session slug/);
      assert.throws(() => loadDebugSession(base, "../escape"), /Invalid debug session slug/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("create surfaces write failures and leaves no visible artifact", () => {
    const base = makeBase();
    try {
      assert.throws(
        () => createDebugSession(
          base,
          { issue: "Write failure case" },
          {
            atomicWrite: () => {
              throw new Error("simulated write failure");
            }
          }
        ),
        /simulated write failure/
      );
      assert.equal(existsSync(debugSessionArtifactPath(base, "write-failure-case")), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("creates sessions directory on first write boundary condition", () => {
    const base = makeBase();
    try {
      const dir = debugSessionsDir(base);
      assert.equal(existsSync(dir), false);
      createDebugSession(base, { issue: "First session" });
      assert.equal(existsSync(dir), true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
describe("debug-session-store: checkpoint and tddGate fields", () => {
  test("checkpoint round-trip: update with checkpoint, load, verify fields intact", () => {
    const base = makeBase();
    try {
      createDebugSession(base, { issue: "Checkpoint test" });
      const checkpoint = {
        type: "human-verify",
        summary: "OAuth redirect URL is misconfigured",
        awaitingResponse: true,
        userResponse: "The redirect URL points to staging, not production"
      };
      updateDebugSession(base, "checkpoint-test", { checkpoint });
      const loaded = loadDebugSession(base, "checkpoint-test");
      assert.ok(loaded !== null);
      assert.deepEqual(loaded.session.checkpoint, checkpoint);
      assert.equal(loaded.session.checkpoint?.type, "human-verify");
      assert.equal(loaded.session.checkpoint?.awaitingResponse, true);
      assert.equal(loaded.session.checkpoint?.userResponse, "The redirect URL points to staging, not production");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("tddGate round-trip: update with tddGate, load, verify fields intact", () => {
    const base = makeBase();
    try {
      createDebugSession(base, { issue: "TDD gate test" });
      const tddGate = {
        enabled: true,
        phase: "red",
        testFile: "src/auth/oauth.test.ts",
        testName: "handles OAuth callback redirect",
        failureOutput: "Expected redirect to /dashboard, got /login"
      };
      updateDebugSession(base, "tdd-gate-test", { tddGate });
      const loaded = loadDebugSession(base, "tdd-gate-test");
      assert.ok(loaded !== null);
      assert.deepEqual(loaded.session.tddGate, tddGate);
      assert.equal(loaded.session.tddGate?.enabled, true);
      assert.equal(loaded.session.tddGate?.phase, "red");
      assert.equal(loaded.session.tddGate?.testFile, "src/auth/oauth.test.ts");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("null-clearing: update with checkpoint then null clears it", () => {
    const base = makeBase();
    try {
      createDebugSession(base, { issue: "Clear checkpoint test" });
      const checkpoint = {
        type: "decision",
        summary: "Needs design decision before continuing",
        awaitingResponse: false
      };
      updateDebugSession(base, "clear-checkpoint-test", { checkpoint });
      const withCheckpoint = loadDebugSession(base, "clear-checkpoint-test");
      assert.ok(withCheckpoint?.session.checkpoint !== null && withCheckpoint?.session.checkpoint !== void 0);
      updateDebugSession(base, "clear-checkpoint-test", { checkpoint: null });
      const cleared = loadDebugSession(base, "clear-checkpoint-test");
      assert.ok(cleared !== null);
      assert.equal(cleared.session.checkpoint, null);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("backward compat: existing artifact without checkpoint/tddGate fields validates successfully", () => {
    const base = makeBase();
    try {
      const sessionsDir = debugSessionsDir(base);
      mkdirSync(sessionsDir, { recursive: true });
      const artifact = {
        version: 1,
        mode: "debug",
        slug: "legacy-session",
        issue: "Legacy issue without new fields",
        status: "active",
        phase: "queued",
        createdAt: 1e3,
        updatedAt: 1e3,
        logPath: join(base, ".gsd", "debug", "legacy-session.log"),
        lastError: null
      };
      writeFileSync(join(sessionsDir, "legacy-session.json"), JSON.stringify(artifact, null, 2), "utf-8");
      const loaded = loadDebugSession(base, "legacy-session");
      assert.ok(loaded !== null, "legacy artifact should load successfully");
      assert.equal(loaded.session.slug, "legacy-session");
      assert.equal(loaded.session.checkpoint, void 0);
      assert.equal(loaded.session.tddGate, void 0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("validator rejects malformed checkpoint \u2014 missing required sub-fields", () => {
    const base = makeBase();
    try {
      const sessionsDir = debugSessionsDir(base);
      mkdirSync(sessionsDir, { recursive: true });
      const artifact = {
        version: 1,
        mode: "debug",
        slug: "bad-checkpoint",
        issue: "Bad checkpoint",
        status: "active",
        phase: "queued",
        createdAt: 1e3,
        updatedAt: 1e3,
        logPath: join(base, ".gsd", "debug", "bad-checkpoint.log"),
        lastError: null,
        checkpoint: {
          type: "human-verify",
          summary: "Something"
          /* awaitingResponse missing */
        }
      };
      writeFileSync(join(sessionsDir, "bad-checkpoint.json"), JSON.stringify(artifact, null, 2), "utf-8");
      assert.throws(
        () => loadDebugSession(base, "bad-checkpoint"),
        /Malformed debug session artifact/
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("validator rejects malformed tddGate \u2014 missing required sub-fields", () => {
    const base = makeBase();
    try {
      const sessionsDir = debugSessionsDir(base);
      mkdirSync(sessionsDir, { recursive: true });
      const artifact = {
        version: 1,
        mode: "debug",
        slug: "bad-tddgate",
        issue: "Bad tddGate",
        status: "active",
        phase: "queued",
        createdAt: 1e3,
        updatedAt: 1e3,
        logPath: join(base, ".gsd", "debug", "bad-tddgate.log"),
        lastError: null,
        tddGate: {
          testFile: "some.test.ts"
          /* enabled and phase missing */
        }
      };
      writeFileSync(join(sessionsDir, "bad-tddgate.json"), JSON.stringify(artifact, null, 2), "utf-8");
      assert.throws(
        () => loadDebugSession(base, "bad-tddgate"),
        /Malformed debug session artifact/
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
describe("debug-session-store: specialistReview field", () => {
  test("specialistReview round-trip: update with review, load, verify all fields intact", () => {
    const base = makeBase();
    try {
      createDebugSession(base, { issue: "Specialist review test" });
      const specialistReview = {
        hint: "Check OAuth token expiry handling",
        skill: "auth-specialist",
        verdict: "SUGGEST_CHANGE (token refresh logic is missing)",
        detail: "The access token is never refreshed before expiry, causing silent auth failures.",
        reviewedAt: 17e8
      };
      updateDebugSession(base, "specialist-review-test", { specialistReview });
      const loaded = loadDebugSession(base, "specialist-review-test");
      assert.ok(loaded !== null);
      assert.deepEqual(loaded.session.specialistReview, specialistReview);
      assert.equal(loaded.session.specialistReview?.hint, "Check OAuth token expiry handling");
      assert.equal(loaded.session.specialistReview?.skill, "auth-specialist");
      assert.equal(loaded.session.specialistReview?.verdict, "SUGGEST_CHANGE (token refresh logic is missing)");
      assert.equal(loaded.session.specialistReview?.reviewedAt, 17e8);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("specialistReview null-clear: update with review then null clears it", () => {
    const base = makeBase();
    try {
      createDebugSession(base, { issue: "Clear specialist review" });
      const specialistReview = {
        hint: "Investigate DB connection pool",
        skill: null,
        verdict: "LOOKS_GOOD (no issue found)",
        detail: "Connection pool is sized correctly for the load profile.",
        reviewedAt: 1700000001
      };
      updateDebugSession(base, "clear-specialist-review", { specialistReview });
      const withReview = loadDebugSession(base, "clear-specialist-review");
      assert.ok(withReview?.session.specialistReview !== null && withReview?.session.specialistReview !== void 0);
      updateDebugSession(base, "clear-specialist-review", { specialistReview: null });
      const cleared = loadDebugSession(base, "clear-specialist-review");
      assert.ok(cleared !== null);
      assert.equal(cleared.session.specialistReview, null);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("backward compat: existing artifact without specialistReview validates successfully", () => {
    const base = makeBase();
    try {
      const sessionsDir = debugSessionsDir(base);
      mkdirSync(sessionsDir, { recursive: true });
      const artifact = {
        version: 1,
        mode: "debug",
        slug: "legacy-no-specialist",
        issue: "Legacy session without specialistReview",
        status: "active",
        phase: "queued",
        createdAt: 1e3,
        updatedAt: 1e3,
        logPath: join(base, ".gsd", "debug", "legacy-no-specialist.log"),
        lastError: null
      };
      writeFileSync(join(sessionsDir, "legacy-no-specialist.json"), JSON.stringify(artifact, null, 2), "utf-8");
      const loaded = loadDebugSession(base, "legacy-no-specialist");
      assert.ok(loaded !== null, "legacy artifact should load successfully");
      assert.equal(loaded.session.specialistReview, void 0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("validator rejects specialistReview with missing required fields (empty object)", () => {
    const base = makeBase();
    try {
      const sessionsDir = debugSessionsDir(base);
      mkdirSync(sessionsDir, { recursive: true });
      const artifact = {
        version: 1,
        mode: "debug",
        slug: "bad-specialist-empty",
        issue: "Bad specialist review",
        status: "active",
        phase: "queued",
        createdAt: 1e3,
        updatedAt: 1e3,
        logPath: join(base, ".gsd", "debug", "bad-specialist-empty.log"),
        lastError: null,
        specialistReview: {}
      };
      writeFileSync(join(sessionsDir, "bad-specialist-empty.json"), JSON.stringify(artifact, null, 2), "utf-8");
      assert.throws(
        () => loadDebugSession(base, "bad-specialist-empty"),
        /Malformed debug session artifact/
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("validator rejects specialistReview with wrong field types (verdict as number, skill as number)", () => {
    const base = makeBase();
    try {
      const sessionsDir = debugSessionsDir(base);
      mkdirSync(sessionsDir, { recursive: true });
      const artifact = {
        version: 1,
        mode: "debug",
        slug: "bad-specialist-types",
        issue: "Bad specialist types",
        status: "active",
        phase: "queued",
        createdAt: 1e3,
        updatedAt: 1e3,
        logPath: join(base, ".gsd", "debug", "bad-specialist-types.log"),
        lastError: null,
        specialistReview: {
          hint: "Check something",
          skill: 42,
          // should be string|null
          verdict: 1,
          // should be string
          detail: "Some detail",
          reviewedAt: 17e8
        }
      };
      writeFileSync(join(sessionsDir, "bad-specialist-types.json"), JSON.stringify(artifact, null, 2), "utf-8");
      assert.throws(
        () => loadDebugSession(base, "bad-specialist-types"),
        /Malformed debug session artifact/
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("validator accepts specialistReview with extra unknown fields (forward compat)", () => {
    const base = makeBase();
    try {
      const sessionsDir = debugSessionsDir(base);
      mkdirSync(sessionsDir, { recursive: true });
      const artifact = {
        version: 1,
        mode: "debug",
        slug: "specialist-extra-fields",
        issue: "Specialist with extra fields",
        status: "active",
        phase: "queued",
        createdAt: 1e3,
        updatedAt: 1e3,
        logPath: join(base, ".gsd", "debug", "specialist-extra-fields.log"),
        lastError: null,
        specialistReview: {
          hint: "Look at caching layer",
          skill: null,
          verdict: "LOOKS_GOOD (cache is correctly invalidated)",
          detail: "TTL is set appropriately.",
          reviewedAt: 1700000002,
          unknownFutureField: "some-value"
          // extra field should be tolerated
        }
      };
      writeFileSync(join(sessionsDir, "specialist-extra-fields.json"), JSON.stringify(artifact, null, 2), "utf-8");
      const loaded = loadDebugSession(base, "specialist-extra-fields");
      assert.ok(loaded !== null, "artifact with extra fields should load successfully");
      assert.equal(loaded.session.specialistReview?.hint, "Look at caching layer");
      assert.equal(loaded.session.specialistReview?.skill, null);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kZWJ1Zy1zZXNzaW9uLXN0b3JlLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0LCB7IGRlc2NyaWJlIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuaW1wb3J0IHtcbiAgYXNzZXJ0VmFsaWREZWJ1Z1Nlc3Npb25TbHVnLFxuICBjcmVhdGVEZWJ1Z1Nlc3Npb24sXG4gIGRlYnVnU2Vzc2lvbkFydGlmYWN0UGF0aCxcbiAgZGVidWdTZXNzaW9uc0RpcixcbiAgbGlzdERlYnVnU2Vzc2lvbnMsXG4gIGxvYWREZWJ1Z1Nlc3Npb24sXG4gIHNsdWdpZnlEZWJ1Z1Nlc3Npb25Jc3N1ZSxcbiAgdXBkYXRlRGVidWdTZXNzaW9uLFxuICB0eXBlIERlYnVnQ2hlY2twb2ludCxcbiAgdHlwZSBEZWJ1Z1NwZWNpYWxpc3RSZXZpZXcsXG4gIHR5cGUgRGVidWdUZGRHYXRlLFxufSBmcm9tIFwiLi4vZGVidWctc2Vzc2lvbi1zdG9yZS50c1wiO1xuXG5mdW5jdGlvbiBtYWtlQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtZGVidWctc2Vzc2lvbi1zdG9yZS1cIikpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZGVzY3JpYmUoXCJkZWJ1Zy1zZXNzaW9uLXN0b3JlOiBjcmVhdGUvbGlzdC9sb2FkL3VwZGF0ZVwiLCAoKSA9PiB7XG4gIHRlc3QoXCJjcmVhdGVzIGZpcnN0IHNlc3Npb24gdW5kZXIgLmdzZC9kZWJ1Zy9zZXNzaW9ucyB3aXRoIGRldGVybWluaXN0aWMgbWV0YWRhdGFcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBjcmVhdGVkID0gY3JlYXRlRGVidWdTZXNzaW9uKGJhc2UsIHtcbiAgICAgICAgaXNzdWU6IFwiTG9naW4gZmFpbHMgb24gU2FmYXJpXCIsXG4gICAgICAgIGNyZWF0ZWRBdDogMTAwMCxcbiAgICAgIH0pO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoY3JlYXRlZC5zZXNzaW9uLnNsdWcsIFwibG9naW4tZmFpbHMtb24tc2FmYXJpXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGNyZWF0ZWQuYXJ0aWZhY3RQYXRoLmluY2x1ZGVzKGpvaW4oXCIuZ3NkXCIsIFwiZGVidWdcIiwgXCJzZXNzaW9uc1wiKSkpO1xuICAgICAgYXNzZXJ0Lm9rKGNyZWF0ZWQuYXJ0aWZhY3RQYXRoLmVuZHNXaXRoKFwibG9naW4tZmFpbHMtb24tc2FmYXJpLmpzb25cIikpO1xuICAgICAgYXNzZXJ0Lm9rKGNyZWF0ZWQuc2Vzc2lvbi5sb2dQYXRoLmluY2x1ZGVzKGpvaW4oXCIuZ3NkXCIsIFwiZGVidWdcIikpKTtcbiAgICAgIGFzc2VydC5vayghY3JlYXRlZC5zZXNzaW9uLmxvZ1BhdGguaW5jbHVkZXMoam9pbihcImRlYnVnXCIsIFwic2Vzc2lvbnNcIikpKTtcbiAgICAgIGFzc2VydC5lcXVhbChjcmVhdGVkLnNlc3Npb24uc3RhdHVzLCBcImFjdGl2ZVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChjcmVhdGVkLnNlc3Npb24ucGhhc2UsIFwicXVldWVkXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGNyZWF0ZWQuc2Vzc2lvbi5jcmVhdGVkQXQsIDEwMDApO1xuICAgICAgYXNzZXJ0LmVxdWFsKGNyZWF0ZWQuc2Vzc2lvbi51cGRhdGVkQXQsIDEwMDApO1xuXG4gICAgICBhc3NlcnQub2soZXhpc3RzU3luYyhjcmVhdGVkLmFydGlmYWN0UGF0aCksIFwic2Vzc2lvbiBhcnRpZmFjdCBzaG91bGQgZXhpc3RcIik7XG4gICAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoY3JlYXRlZC5hcnRpZmFjdFBhdGgsIFwidXRmLThcIik7XG4gICAgICBhc3NlcnQub2socmF3LmluY2x1ZGVzKCdcInNsdWdcIjogXCJsb2dpbi1mYWlscy1vbi1zYWZhcmlcIicpKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJjb2xsaXNpb24tc2FmZSBzbHVnZ2luZyBhbGxvd3MgbXVsdGlwbGUgc2FtZS10aXRsZSBzZXNzaW9uc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGEgPSBjcmVhdGVEZWJ1Z1Nlc3Npb24oYmFzZSwgeyBpc3N1ZTogXCJBdXRoIGlzc3VlXCIgfSk7XG4gICAgICBjb25zdCBiID0gY3JlYXRlRGVidWdTZXNzaW9uKGJhc2UsIHsgaXNzdWU6IFwiQXV0aCBpc3N1ZVwiIH0pO1xuICAgICAgY29uc3QgYyA9IGNyZWF0ZURlYnVnU2Vzc2lvbihiYXNlLCB7IGlzc3VlOiBcIkF1dGggaXNzdWVcIiB9KTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKGEuc2Vzc2lvbi5zbHVnLCBcImF1dGgtaXNzdWVcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoYi5zZXNzaW9uLnNsdWcsIFwiYXV0aC1pc3N1ZS0yXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGMuc2Vzc2lvbi5zbHVnLCBcImF1dGgtaXNzdWUtM1wiKTtcbiAgICAgIGFzc2VydC5vayhleGlzdHNTeW5jKGRlYnVnU2Vzc2lvbkFydGlmYWN0UGF0aChiYXNlLCBcImF1dGgtaXNzdWVcIikpKTtcbiAgICAgIGFzc2VydC5vayhleGlzdHNTeW5jKGRlYnVnU2Vzc2lvbkFydGlmYWN0UGF0aChiYXNlLCBcImF1dGgtaXNzdWUtMlwiKSkpO1xuICAgICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoZGVidWdTZXNzaW9uQXJ0aWZhY3RQYXRoKGJhc2UsIFwiYXV0aC1pc3N1ZS0zXCIpKSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwibGlzdCByZXR1cm5zIGRldGVybWluaXN0aWMgb3JkZXJpbmcgYnkgdXBkYXRlZEF0IGRlc2MgdGhlbiBzbHVnXCIsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY3JlYXRlRGVidWdTZXNzaW9uKGJhc2UsIHsgaXNzdWU6IFwiRmlyc3RcIiwgY3JlYXRlZEF0OiAxMDAgfSk7XG4gICAgICBjcmVhdGVEZWJ1Z1Nlc3Npb24oYmFzZSwgeyBpc3N1ZTogXCJTZWNvbmRcIiwgY3JlYXRlZEF0OiAyMDAgfSk7XG4gICAgICBjcmVhdGVEZWJ1Z1Nlc3Npb24oYmFzZSwgeyBpc3N1ZTogXCJUaGlyZFwiLCBjcmVhdGVkQXQ6IDMwMCB9KTtcblxuICAgICAgdXBkYXRlRGVidWdTZXNzaW9uKGJhc2UsIFwiZmlyc3RcIiwgeyBwaGFzZTogXCJ0cmlhZ2VcIiwgdXBkYXRlZEF0OiA1MDAgfSk7XG5cbiAgICAgIGNvbnN0IGxpc3RlZCA9IGxpc3REZWJ1Z1Nlc3Npb25zKGJhc2UpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGxpc3RlZC5tYWxmb3JtZWQubGVuZ3RoLCAwKTtcbiAgICAgIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgICAgIGxpc3RlZC5zZXNzaW9ucy5tYXAocyA9PiBzLnNlc3Npb24uc2x1ZyksXG4gICAgICAgIFtcImZpcnN0XCIsIFwidGhpcmRcIiwgXCJzZWNvbmRcIl0sXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImxvYWQgcmV0dXJucyBudWxsIHdoZW4gc2x1ZyBkb2VzIG5vdCBleGlzdFwiLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGxvYWRlZCA9IGxvYWREZWJ1Z1Nlc3Npb24oYmFzZSwgXCJtaXNzaW5nLXNsdWdcIik7XG4gICAgICBhc3NlcnQuZXF1YWwobG9hZGVkLCBudWxsKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJ1cGRhdGUgcGVyc2lzdHMgc3RhdHVzL3BoYXNlL2Vycm9yIG1ldGFkYXRhIGZvciBvYnNlcnZhYmlsaXR5XCIsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY3JlYXRlRGVidWdTZXNzaW9uKGJhc2UsIHsgaXNzdWU6IFwiUmF0ZSBsaW1pdCBmbGFrZVwiLCBjcmVhdGVkQXQ6IDEwIH0pO1xuICAgICAgY29uc3QgdXBkYXRlZCA9IHVwZGF0ZURlYnVnU2Vzc2lvbihiYXNlLCBcInJhdGUtbGltaXQtZmxha2VcIiwge1xuICAgICAgICBzdGF0dXM6IFwiZmFpbGVkXCIsXG4gICAgICAgIHBoYXNlOiBcImRpYWdub3NpbmdcIixcbiAgICAgICAgbGFzdEVycm9yOiBcIlRpbWVvdXQgd2FpdGluZyBmb3IgaGVhbHRoIGNoZWNrXCIsXG4gICAgICAgIHVwZGF0ZWRBdDogNDIsXG4gICAgICB9KTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHVwZGF0ZWQuc2Vzc2lvbi5zdGF0dXMsIFwiZmFpbGVkXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHVwZGF0ZWQuc2Vzc2lvbi5waGFzZSwgXCJkaWFnbm9zaW5nXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHVwZGF0ZWQuc2Vzc2lvbi5sYXN0RXJyb3IsIFwiVGltZW91dCB3YWl0aW5nIGZvciBoZWFsdGggY2hlY2tcIik7XG4gICAgICBhc3NlcnQuZXF1YWwodXBkYXRlZC5zZXNzaW9uLnVwZGF0ZWRBdCwgNDIpO1xuXG4gICAgICBjb25zdCBsaXN0ZWQgPSBsaXN0RGVidWdTZXNzaW9ucyhiYXNlKTtcbiAgICAgIGFzc2VydC5lcXVhbChsaXN0ZWQuc2Vzc2lvbnNbMF0uc2Vzc2lvbi5zdGF0dXMsIFwiZmFpbGVkXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGxpc3RlZC5zZXNzaW9uc1swXS5zZXNzaW9uLnBoYXNlLCBcImRpYWdub3NpbmdcIik7XG4gICAgICBhc3NlcnQuZXF1YWwobGlzdGVkLnNlc3Npb25zWzBdLnNlc3Npb24udXBkYXRlZEF0LCA0Mik7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcImRlYnVnLXNlc3Npb24tc3RvcmU6IG1hbGZvcm1lZCBhcnRpZmFjdHMgKyBuZWdhdGl2ZSBwYXRoc1wiLCAoKSA9PiB7XG4gIHRlc3QoXCJsaXN0IGNvbnRpbnVlcyBoZWFsdGh5IHNlc3Npb25zIHdoaWxlIHN1cmZhY2luZyBtYWxmb3JtZWQgYXJ0aWZhY3QgcGF0aHNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjcmVhdGVEZWJ1Z1Nlc3Npb24oYmFzZSwgeyBpc3N1ZTogXCJIZWFsdGh5IGlzc3VlXCIsIGNyZWF0ZWRBdDogMSB9KTtcbiAgICAgIGNvbnN0IHNlc3Npb25zUGF0aCA9IGRlYnVnU2Vzc2lvbnNEaXIoYmFzZSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4oc2Vzc2lvbnNQYXRoLCBcImNvcnJ1cHQuanNvblwiKSwgXCJ7IHRoaXMgaXMgbm90IGpzb25cIiwgXCJ1dGYtOFwiKTtcblxuICAgICAgY29uc3QgbGlzdGVkID0gbGlzdERlYnVnU2Vzc2lvbnMoYmFzZSk7XG4gICAgICBhc3NlcnQuZXF1YWwobGlzdGVkLnNlc3Npb25zLmxlbmd0aCwgMSk7XG4gICAgICBhc3NlcnQuZXF1YWwobGlzdGVkLnNlc3Npb25zWzBdLnNlc3Npb24uc2x1ZywgXCJoZWFsdGh5LWlzc3VlXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGxpc3RlZC5tYWxmb3JtZWQubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5vayhsaXN0ZWQubWFsZm9ybWVkWzBdLmFydGlmYWN0UGF0aC5lbmRzV2l0aChqb2luKFwic2Vzc2lvbnNcIiwgXCJjb3JydXB0Lmpzb25cIikpKTtcbiAgICAgIGFzc2VydC5tYXRjaChsaXN0ZWQubWFsZm9ybWVkWzBdLm1lc3NhZ2UsIC9wYXJzZSBkZWJ1ZyBzZXNzaW9uIGFydGlmYWN0L2kpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInJlamVjdHMgZW1wdHkgaXNzdWUgdGV4dCBhbmQgdW5zdXBwb3J0ZWQgdG9rZW5zIHRoYXQgc2x1Z2lmeSB0byBlbXB0eVwiLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGFzc2VydC50aHJvd3MoXG4gICAgICAgICgpID0+IGNyZWF0ZURlYnVnU2Vzc2lvbihiYXNlLCB7IGlzc3VlOiBcIiAgIFwiIH0pLFxuICAgICAgICAvSXNzdWUgdGV4dCBpcyByZXF1aXJlZC9pLFxuICAgICAgKTtcblxuICAgICAgYXNzZXJ0LnRocm93cyhcbiAgICAgICAgKCkgPT4gc2x1Z2lmeURlYnVnU2Vzc2lvbklzc3VlKFwiXHVEODNEXHVERDI1XHVEODNEXHVERDI1XHVEODNEXHVERDI1XCIpLFxuICAgICAgICAvYWxwaGFudW1lcmljL2ksXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInNsdWdpZnkgbm9ybWFsaXplcyB1bnN1cHBvcnRlZCBjaGFyYWN0ZXJzIGludG8gZGV0ZXJtaW5pc3RpYyB0b2tlbnNcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHNsdWdpZnlEZWJ1Z1Nlc3Npb25Jc3N1ZShcIiBBUEkgLyBsb2dpbiBcdUQ4M0RcdURFQTggZmxha3kgIFwiKSxcbiAgICAgIFwiYXBpLWxvZ2luLWZsYWt5XCIsXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcImludmFsaWQgc2x1ZyB0b2tlbnMgYXJlIHJlamVjdGVkIGZvciBsb2FkL3BhdGggdmFsaWRhdGlvblwiLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGFzc2VydC50aHJvd3MoKCkgPT4gYXNzZXJ0VmFsaWREZWJ1Z1Nlc3Npb25TbHVnKFwiLi4vZXNjYXBlXCIpLCAvSW52YWxpZCBkZWJ1ZyBzZXNzaW9uIHNsdWcvKTtcbiAgICAgIGFzc2VydC50aHJvd3MoKCkgPT4gbG9hZERlYnVnU2Vzc2lvbihiYXNlLCBcIi4uL2VzY2FwZVwiKSwgL0ludmFsaWQgZGVidWcgc2Vzc2lvbiBzbHVnLyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiY3JlYXRlIHN1cmZhY2VzIHdyaXRlIGZhaWx1cmVzIGFuZCBsZWF2ZXMgbm8gdmlzaWJsZSBhcnRpZmFjdFwiLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGFzc2VydC50aHJvd3MoXG4gICAgICAgICgpID0+IGNyZWF0ZURlYnVnU2Vzc2lvbihcbiAgICAgICAgICBiYXNlLFxuICAgICAgICAgIHsgaXNzdWU6IFwiV3JpdGUgZmFpbHVyZSBjYXNlXCIgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBhdG9taWNXcml0ZTogKCkgPT4ge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJzaW11bGF0ZWQgd3JpdGUgZmFpbHVyZVwiKTtcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgKSxcbiAgICAgICAgL3NpbXVsYXRlZCB3cml0ZSBmYWlsdXJlLyxcbiAgICAgICk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChleGlzdHNTeW5jKGRlYnVnU2Vzc2lvbkFydGlmYWN0UGF0aChiYXNlLCBcIndyaXRlLWZhaWx1cmUtY2FzZVwiKSksIGZhbHNlKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJjcmVhdGVzIHNlc3Npb25zIGRpcmVjdG9yeSBvbiBmaXJzdCB3cml0ZSBib3VuZGFyeSBjb25kaXRpb25cIiwgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBkaXIgPSBkZWJ1Z1Nlc3Npb25zRGlyKGJhc2UpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGV4aXN0c1N5bmMoZGlyKSwgZmFsc2UpO1xuXG4gICAgICBjcmVhdGVEZWJ1Z1Nlc3Npb24oYmFzZSwgeyBpc3N1ZTogXCJGaXJzdCBzZXNzaW9uXCIgfSk7XG4gICAgICBhc3NlcnQuZXF1YWwoZXhpc3RzU3luYyhkaXIpLCB0cnVlKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiZGVidWctc2Vzc2lvbi1zdG9yZTogY2hlY2twb2ludCBhbmQgdGRkR2F0ZSBmaWVsZHNcIiwgKCkgPT4ge1xuICB0ZXN0KFwiY2hlY2twb2ludCByb3VuZC10cmlwOiB1cGRhdGUgd2l0aCBjaGVja3BvaW50LCBsb2FkLCB2ZXJpZnkgZmllbGRzIGludGFjdFwiLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNyZWF0ZURlYnVnU2Vzc2lvbihiYXNlLCB7IGlzc3VlOiBcIkNoZWNrcG9pbnQgdGVzdFwiIH0pO1xuXG4gICAgICBjb25zdCBjaGVja3BvaW50OiBEZWJ1Z0NoZWNrcG9pbnQgPSB7XG4gICAgICAgIHR5cGU6IFwiaHVtYW4tdmVyaWZ5XCIsXG4gICAgICAgIHN1bW1hcnk6IFwiT0F1dGggcmVkaXJlY3QgVVJMIGlzIG1pc2NvbmZpZ3VyZWRcIixcbiAgICAgICAgYXdhaXRpbmdSZXNwb25zZTogdHJ1ZSxcbiAgICAgICAgdXNlclJlc3BvbnNlOiBcIlRoZSByZWRpcmVjdCBVUkwgcG9pbnRzIHRvIHN0YWdpbmcsIG5vdCBwcm9kdWN0aW9uXCIsXG4gICAgICB9O1xuICAgICAgdXBkYXRlRGVidWdTZXNzaW9uKGJhc2UsIFwiY2hlY2twb2ludC10ZXN0XCIsIHsgY2hlY2twb2ludCB9KTtcblxuICAgICAgY29uc3QgbG9hZGVkID0gbG9hZERlYnVnU2Vzc2lvbihiYXNlLCBcImNoZWNrcG9pbnQtdGVzdFwiKTtcbiAgICAgIGFzc2VydC5vayhsb2FkZWQgIT09IG51bGwpO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChsb2FkZWQuc2Vzc2lvbi5jaGVja3BvaW50LCBjaGVja3BvaW50KTtcbiAgICAgIGFzc2VydC5lcXVhbChsb2FkZWQuc2Vzc2lvbi5jaGVja3BvaW50Py50eXBlLCBcImh1bWFuLXZlcmlmeVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChsb2FkZWQuc2Vzc2lvbi5jaGVja3BvaW50Py5hd2FpdGluZ1Jlc3BvbnNlLCB0cnVlKTtcbiAgICAgIGFzc2VydC5lcXVhbChsb2FkZWQuc2Vzc2lvbi5jaGVja3BvaW50Py51c2VyUmVzcG9uc2UsIFwiVGhlIHJlZGlyZWN0IFVSTCBwb2ludHMgdG8gc3RhZ2luZywgbm90IHByb2R1Y3Rpb25cIik7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwidGRkR2F0ZSByb3VuZC10cmlwOiB1cGRhdGUgd2l0aCB0ZGRHYXRlLCBsb2FkLCB2ZXJpZnkgZmllbGRzIGludGFjdFwiLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNyZWF0ZURlYnVnU2Vzc2lvbihiYXNlLCB7IGlzc3VlOiBcIlRERCBnYXRlIHRlc3RcIiB9KTtcblxuICAgICAgY29uc3QgdGRkR2F0ZTogRGVidWdUZGRHYXRlID0ge1xuICAgICAgICBlbmFibGVkOiB0cnVlLFxuICAgICAgICBwaGFzZTogXCJyZWRcIixcbiAgICAgICAgdGVzdEZpbGU6IFwic3JjL2F1dGgvb2F1dGgudGVzdC50c1wiLFxuICAgICAgICB0ZXN0TmFtZTogXCJoYW5kbGVzIE9BdXRoIGNhbGxiYWNrIHJlZGlyZWN0XCIsXG4gICAgICAgIGZhaWx1cmVPdXRwdXQ6IFwiRXhwZWN0ZWQgcmVkaXJlY3QgdG8gL2Rhc2hib2FyZCwgZ290IC9sb2dpblwiLFxuICAgICAgfTtcbiAgICAgIHVwZGF0ZURlYnVnU2Vzc2lvbihiYXNlLCBcInRkZC1nYXRlLXRlc3RcIiwgeyB0ZGRHYXRlIH0pO1xuXG4gICAgICBjb25zdCBsb2FkZWQgPSBsb2FkRGVidWdTZXNzaW9uKGJhc2UsIFwidGRkLWdhdGUtdGVzdFwiKTtcbiAgICAgIGFzc2VydC5vayhsb2FkZWQgIT09IG51bGwpO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChsb2FkZWQuc2Vzc2lvbi50ZGRHYXRlLCB0ZGRHYXRlKTtcbiAgICAgIGFzc2VydC5lcXVhbChsb2FkZWQuc2Vzc2lvbi50ZGRHYXRlPy5lbmFibGVkLCB0cnVlKTtcbiAgICAgIGFzc2VydC5lcXVhbChsb2FkZWQuc2Vzc2lvbi50ZGRHYXRlPy5waGFzZSwgXCJyZWRcIik7XG4gICAgICBhc3NlcnQuZXF1YWwobG9hZGVkLnNlc3Npb24udGRkR2F0ZT8udGVzdEZpbGUsIFwic3JjL2F1dGgvb2F1dGgudGVzdC50c1wiKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJudWxsLWNsZWFyaW5nOiB1cGRhdGUgd2l0aCBjaGVja3BvaW50IHRoZW4gbnVsbCBjbGVhcnMgaXRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjcmVhdGVEZWJ1Z1Nlc3Npb24oYmFzZSwgeyBpc3N1ZTogXCJDbGVhciBjaGVja3BvaW50IHRlc3RcIiB9KTtcblxuICAgICAgY29uc3QgY2hlY2twb2ludDogRGVidWdDaGVja3BvaW50ID0ge1xuICAgICAgICB0eXBlOiBcImRlY2lzaW9uXCIsXG4gICAgICAgIHN1bW1hcnk6IFwiTmVlZHMgZGVzaWduIGRlY2lzaW9uIGJlZm9yZSBjb250aW51aW5nXCIsXG4gICAgICAgIGF3YWl0aW5nUmVzcG9uc2U6IGZhbHNlLFxuICAgICAgfTtcbiAgICAgIHVwZGF0ZURlYnVnU2Vzc2lvbihiYXNlLCBcImNsZWFyLWNoZWNrcG9pbnQtdGVzdFwiLCB7IGNoZWNrcG9pbnQgfSk7XG5cbiAgICAgIC8vIFZlcmlmeSBpdCB3YXMgc2V0XG4gICAgICBjb25zdCB3aXRoQ2hlY2twb2ludCA9IGxvYWREZWJ1Z1Nlc3Npb24oYmFzZSwgXCJjbGVhci1jaGVja3BvaW50LXRlc3RcIik7XG4gICAgICBhc3NlcnQub2sod2l0aENoZWNrcG9pbnQ/LnNlc3Npb24uY2hlY2twb2ludCAhPT0gbnVsbCAmJiB3aXRoQ2hlY2twb2ludD8uc2Vzc2lvbi5jaGVja3BvaW50ICE9PSB1bmRlZmluZWQpO1xuXG4gICAgICAvLyBDbGVhciBpdFxuICAgICAgdXBkYXRlRGVidWdTZXNzaW9uKGJhc2UsIFwiY2xlYXItY2hlY2twb2ludC10ZXN0XCIsIHsgY2hlY2twb2ludDogbnVsbCB9KTtcblxuICAgICAgY29uc3QgY2xlYXJlZCA9IGxvYWREZWJ1Z1Nlc3Npb24oYmFzZSwgXCJjbGVhci1jaGVja3BvaW50LXRlc3RcIik7XG4gICAgICBhc3NlcnQub2soY2xlYXJlZCAhPT0gbnVsbCk7XG4gICAgICBhc3NlcnQuZXF1YWwoY2xlYXJlZC5zZXNzaW9uLmNoZWNrcG9pbnQsIG51bGwpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImJhY2t3YXJkIGNvbXBhdDogZXhpc3RpbmcgYXJ0aWZhY3Qgd2l0aG91dCBjaGVja3BvaW50L3RkZEdhdGUgZmllbGRzIHZhbGlkYXRlcyBzdWNjZXNzZnVsbHlcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICAvLyBXcml0ZSBhIG1pbmltYWwgdmFsaWQgYXJ0aWZhY3QgdGhhdCBsYWNrcyBjaGVja3BvaW50IGFuZCB0ZGRHYXRlIFx1MjAxNCBzaW11bGF0ZXMgUzAyIGFydGlmYWN0XG4gICAgICBjb25zdCBzZXNzaW9uc0RpciA9IGRlYnVnU2Vzc2lvbnNEaXIoYmFzZSk7XG4gICAgICBta2RpclN5bmMoc2Vzc2lvbnNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgY29uc3QgYXJ0aWZhY3QgPSB7XG4gICAgICAgIHZlcnNpb246IDEsXG4gICAgICAgIG1vZGU6IFwiZGVidWdcIixcbiAgICAgICAgc2x1ZzogXCJsZWdhY3ktc2Vzc2lvblwiLFxuICAgICAgICBpc3N1ZTogXCJMZWdhY3kgaXNzdWUgd2l0aG91dCBuZXcgZmllbGRzXCIsXG4gICAgICAgIHN0YXR1czogXCJhY3RpdmVcIixcbiAgICAgICAgcGhhc2U6IFwicXVldWVkXCIsXG4gICAgICAgIGNyZWF0ZWRBdDogMTAwMCxcbiAgICAgICAgdXBkYXRlZEF0OiAxMDAwLFxuICAgICAgICBsb2dQYXRoOiBqb2luKGJhc2UsIFwiLmdzZFwiLCBcImRlYnVnXCIsIFwibGVnYWN5LXNlc3Npb24ubG9nXCIpLFxuICAgICAgICBsYXN0RXJyb3I6IG51bGwsXG4gICAgICB9O1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHNlc3Npb25zRGlyLCBcImxlZ2FjeS1zZXNzaW9uLmpzb25cIiksIEpTT04uc3RyaW5naWZ5KGFydGlmYWN0LCBudWxsLCAyKSwgXCJ1dGYtOFwiKTtcblxuICAgICAgY29uc3QgbG9hZGVkID0gbG9hZERlYnVnU2Vzc2lvbihiYXNlLCBcImxlZ2FjeS1zZXNzaW9uXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGxvYWRlZCAhPT0gbnVsbCwgXCJsZWdhY3kgYXJ0aWZhY3Qgc2hvdWxkIGxvYWQgc3VjY2Vzc2Z1bGx5XCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGxvYWRlZC5zZXNzaW9uLnNsdWcsIFwibGVnYWN5LXNlc3Npb25cIik7XG4gICAgICBhc3NlcnQuZXF1YWwobG9hZGVkLnNlc3Npb24uY2hlY2twb2ludCwgdW5kZWZpbmVkKTtcbiAgICAgIGFzc2VydC5lcXVhbChsb2FkZWQuc2Vzc2lvbi50ZGRHYXRlLCB1bmRlZmluZWQpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInZhbGlkYXRvciByZWplY3RzIG1hbGZvcm1lZCBjaGVja3BvaW50IFx1MjAxNCBtaXNzaW5nIHJlcXVpcmVkIHN1Yi1maWVsZHNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzZXNzaW9uc0RpciA9IGRlYnVnU2Vzc2lvbnNEaXIoYmFzZSk7XG4gICAgICBta2RpclN5bmMoc2Vzc2lvbnNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgLy8gY2hlY2twb2ludCBwcmVzZW50IGJ1dCBtaXNzaW5nICdhd2FpdGluZ1Jlc3BvbnNlJ1xuICAgICAgY29uc3QgYXJ0aWZhY3QgPSB7XG4gICAgICAgIHZlcnNpb246IDEsXG4gICAgICAgIG1vZGU6IFwiZGVidWdcIixcbiAgICAgICAgc2x1ZzogXCJiYWQtY2hlY2twb2ludFwiLFxuICAgICAgICBpc3N1ZTogXCJCYWQgY2hlY2twb2ludFwiLFxuICAgICAgICBzdGF0dXM6IFwiYWN0aXZlXCIsXG4gICAgICAgIHBoYXNlOiBcInF1ZXVlZFwiLFxuICAgICAgICBjcmVhdGVkQXQ6IDEwMDAsXG4gICAgICAgIHVwZGF0ZWRBdDogMTAwMCxcbiAgICAgICAgbG9nUGF0aDogam9pbihiYXNlLCBcIi5nc2RcIiwgXCJkZWJ1Z1wiLCBcImJhZC1jaGVja3BvaW50LmxvZ1wiKSxcbiAgICAgICAgbGFzdEVycm9yOiBudWxsLFxuICAgICAgICBjaGVja3BvaW50OiB7IHR5cGU6IFwiaHVtYW4tdmVyaWZ5XCIsIHN1bW1hcnk6IFwiU29tZXRoaW5nXCIgLyogYXdhaXRpbmdSZXNwb25zZSBtaXNzaW5nICovIH0sXG4gICAgICB9O1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHNlc3Npb25zRGlyLCBcImJhZC1jaGVja3BvaW50Lmpzb25cIiksIEpTT04uc3RyaW5naWZ5KGFydGlmYWN0LCBudWxsLCAyKSwgXCJ1dGYtOFwiKTtcblxuICAgICAgYXNzZXJ0LnRocm93cyhcbiAgICAgICAgKCkgPT4gbG9hZERlYnVnU2Vzc2lvbihiYXNlLCBcImJhZC1jaGVja3BvaW50XCIpLFxuICAgICAgICAvTWFsZm9ybWVkIGRlYnVnIHNlc3Npb24gYXJ0aWZhY3QvLFxuICAgICAgKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJ2YWxpZGF0b3IgcmVqZWN0cyBtYWxmb3JtZWQgdGRkR2F0ZSBcdTIwMTQgbWlzc2luZyByZXF1aXJlZCBzdWItZmllbGRzXCIsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc2Vzc2lvbnNEaXIgPSBkZWJ1Z1Nlc3Npb25zRGlyKGJhc2UpO1xuICAgICAgbWtkaXJTeW5jKHNlc3Npb25zRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIC8vIHRkZEdhdGUgcHJlc2VudCBidXQgbWlzc2luZyAnZW5hYmxlZCcgYW5kICdwaGFzZSdcbiAgICAgIGNvbnN0IGFydGlmYWN0ID0ge1xuICAgICAgICB2ZXJzaW9uOiAxLFxuICAgICAgICBtb2RlOiBcImRlYnVnXCIsXG4gICAgICAgIHNsdWc6IFwiYmFkLXRkZGdhdGVcIixcbiAgICAgICAgaXNzdWU6IFwiQmFkIHRkZEdhdGVcIixcbiAgICAgICAgc3RhdHVzOiBcImFjdGl2ZVwiLFxuICAgICAgICBwaGFzZTogXCJxdWV1ZWRcIixcbiAgICAgICAgY3JlYXRlZEF0OiAxMDAwLFxuICAgICAgICB1cGRhdGVkQXQ6IDEwMDAsXG4gICAgICAgIGxvZ1BhdGg6IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZGVidWdcIiwgXCJiYWQtdGRkZ2F0ZS5sb2dcIiksXG4gICAgICAgIGxhc3RFcnJvcjogbnVsbCxcbiAgICAgICAgdGRkR2F0ZTogeyB0ZXN0RmlsZTogXCJzb21lLnRlc3QudHNcIiAvKiBlbmFibGVkIGFuZCBwaGFzZSBtaXNzaW5nICovIH0sXG4gICAgICB9O1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHNlc3Npb25zRGlyLCBcImJhZC10ZGRnYXRlLmpzb25cIiksIEpTT04uc3RyaW5naWZ5KGFydGlmYWN0LCBudWxsLCAyKSwgXCJ1dGYtOFwiKTtcblxuICAgICAgYXNzZXJ0LnRocm93cyhcbiAgICAgICAgKCkgPT4gbG9hZERlYnVnU2Vzc2lvbihiYXNlLCBcImJhZC10ZGRnYXRlXCIpLFxuICAgICAgICAvTWFsZm9ybWVkIGRlYnVnIHNlc3Npb24gYXJ0aWZhY3QvLFxuICAgICAgKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiZGVidWctc2Vzc2lvbi1zdG9yZTogc3BlY2lhbGlzdFJldmlldyBmaWVsZFwiLCAoKSA9PiB7XG4gIHRlc3QoXCJzcGVjaWFsaXN0UmV2aWV3IHJvdW5kLXRyaXA6IHVwZGF0ZSB3aXRoIHJldmlldywgbG9hZCwgdmVyaWZ5IGFsbCBmaWVsZHMgaW50YWN0XCIsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY3JlYXRlRGVidWdTZXNzaW9uKGJhc2UsIHsgaXNzdWU6IFwiU3BlY2lhbGlzdCByZXZpZXcgdGVzdFwiIH0pO1xuXG4gICAgICBjb25zdCBzcGVjaWFsaXN0UmV2aWV3OiBEZWJ1Z1NwZWNpYWxpc3RSZXZpZXcgPSB7XG4gICAgICAgIGhpbnQ6IFwiQ2hlY2sgT0F1dGggdG9rZW4gZXhwaXJ5IGhhbmRsaW5nXCIsXG4gICAgICAgIHNraWxsOiBcImF1dGgtc3BlY2lhbGlzdFwiLFxuICAgICAgICB2ZXJkaWN0OiBcIlNVR0dFU1RfQ0hBTkdFICh0b2tlbiByZWZyZXNoIGxvZ2ljIGlzIG1pc3NpbmcpXCIsXG4gICAgICAgIGRldGFpbDogXCJUaGUgYWNjZXNzIHRva2VuIGlzIG5ldmVyIHJlZnJlc2hlZCBiZWZvcmUgZXhwaXJ5LCBjYXVzaW5nIHNpbGVudCBhdXRoIGZhaWx1cmVzLlwiLFxuICAgICAgICByZXZpZXdlZEF0OiAxNzAwMDAwMDAwLFxuICAgICAgfTtcbiAgICAgIHVwZGF0ZURlYnVnU2Vzc2lvbihiYXNlLCBcInNwZWNpYWxpc3QtcmV2aWV3LXRlc3RcIiwgeyBzcGVjaWFsaXN0UmV2aWV3IH0pO1xuXG4gICAgICBjb25zdCBsb2FkZWQgPSBsb2FkRGVidWdTZXNzaW9uKGJhc2UsIFwic3BlY2lhbGlzdC1yZXZpZXctdGVzdFwiKTtcbiAgICAgIGFzc2VydC5vayhsb2FkZWQgIT09IG51bGwpO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChsb2FkZWQuc2Vzc2lvbi5zcGVjaWFsaXN0UmV2aWV3LCBzcGVjaWFsaXN0UmV2aWV3KTtcbiAgICAgIGFzc2VydC5lcXVhbChsb2FkZWQuc2Vzc2lvbi5zcGVjaWFsaXN0UmV2aWV3Py5oaW50LCBcIkNoZWNrIE9BdXRoIHRva2VuIGV4cGlyeSBoYW5kbGluZ1wiKTtcbiAgICAgIGFzc2VydC5lcXVhbChsb2FkZWQuc2Vzc2lvbi5zcGVjaWFsaXN0UmV2aWV3Py5za2lsbCwgXCJhdXRoLXNwZWNpYWxpc3RcIik7XG4gICAgICBhc3NlcnQuZXF1YWwobG9hZGVkLnNlc3Npb24uc3BlY2lhbGlzdFJldmlldz8udmVyZGljdCwgXCJTVUdHRVNUX0NIQU5HRSAodG9rZW4gcmVmcmVzaCBsb2dpYyBpcyBtaXNzaW5nKVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChsb2FkZWQuc2Vzc2lvbi5zcGVjaWFsaXN0UmV2aWV3Py5yZXZpZXdlZEF0LCAxNzAwMDAwMDAwKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJzcGVjaWFsaXN0UmV2aWV3IG51bGwtY2xlYXI6IHVwZGF0ZSB3aXRoIHJldmlldyB0aGVuIG51bGwgY2xlYXJzIGl0XCIsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY3JlYXRlRGVidWdTZXNzaW9uKGJhc2UsIHsgaXNzdWU6IFwiQ2xlYXIgc3BlY2lhbGlzdCByZXZpZXdcIiB9KTtcblxuICAgICAgY29uc3Qgc3BlY2lhbGlzdFJldmlldzogRGVidWdTcGVjaWFsaXN0UmV2aWV3ID0ge1xuICAgICAgICBoaW50OiBcIkludmVzdGlnYXRlIERCIGNvbm5lY3Rpb24gcG9vbFwiLFxuICAgICAgICBza2lsbDogbnVsbCxcbiAgICAgICAgdmVyZGljdDogXCJMT09LU19HT09EIChubyBpc3N1ZSBmb3VuZClcIixcbiAgICAgICAgZGV0YWlsOiBcIkNvbm5lY3Rpb24gcG9vbCBpcyBzaXplZCBjb3JyZWN0bHkgZm9yIHRoZSBsb2FkIHByb2ZpbGUuXCIsXG4gICAgICAgIHJldmlld2VkQXQ6IDE3MDAwMDAwMDEsXG4gICAgICB9O1xuICAgICAgdXBkYXRlRGVidWdTZXNzaW9uKGJhc2UsIFwiY2xlYXItc3BlY2lhbGlzdC1yZXZpZXdcIiwgeyBzcGVjaWFsaXN0UmV2aWV3IH0pO1xuXG4gICAgICBjb25zdCB3aXRoUmV2aWV3ID0gbG9hZERlYnVnU2Vzc2lvbihiYXNlLCBcImNsZWFyLXNwZWNpYWxpc3QtcmV2aWV3XCIpO1xuICAgICAgYXNzZXJ0Lm9rKHdpdGhSZXZpZXc/LnNlc3Npb24uc3BlY2lhbGlzdFJldmlldyAhPT0gbnVsbCAmJiB3aXRoUmV2aWV3Py5zZXNzaW9uLnNwZWNpYWxpc3RSZXZpZXcgIT09IHVuZGVmaW5lZCk7XG5cbiAgICAgIHVwZGF0ZURlYnVnU2Vzc2lvbihiYXNlLCBcImNsZWFyLXNwZWNpYWxpc3QtcmV2aWV3XCIsIHsgc3BlY2lhbGlzdFJldmlldzogbnVsbCB9KTtcblxuICAgICAgY29uc3QgY2xlYXJlZCA9IGxvYWREZWJ1Z1Nlc3Npb24oYmFzZSwgXCJjbGVhci1zcGVjaWFsaXN0LXJldmlld1wiKTtcbiAgICAgIGFzc2VydC5vayhjbGVhcmVkICE9PSBudWxsKTtcbiAgICAgIGFzc2VydC5lcXVhbChjbGVhcmVkLnNlc3Npb24uc3BlY2lhbGlzdFJldmlldywgbnVsbCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiYmFja3dhcmQgY29tcGF0OiBleGlzdGluZyBhcnRpZmFjdCB3aXRob3V0IHNwZWNpYWxpc3RSZXZpZXcgdmFsaWRhdGVzIHN1Y2Nlc3NmdWxseVwiLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHNlc3Npb25zRGlyID0gZGVidWdTZXNzaW9uc0RpcihiYXNlKTtcbiAgICAgIG1rZGlyU3luYyhzZXNzaW9uc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBjb25zdCBhcnRpZmFjdCA9IHtcbiAgICAgICAgdmVyc2lvbjogMSxcbiAgICAgICAgbW9kZTogXCJkZWJ1Z1wiLFxuICAgICAgICBzbHVnOiBcImxlZ2FjeS1uby1zcGVjaWFsaXN0XCIsXG4gICAgICAgIGlzc3VlOiBcIkxlZ2FjeSBzZXNzaW9uIHdpdGhvdXQgc3BlY2lhbGlzdFJldmlld1wiLFxuICAgICAgICBzdGF0dXM6IFwiYWN0aXZlXCIsXG4gICAgICAgIHBoYXNlOiBcInF1ZXVlZFwiLFxuICAgICAgICBjcmVhdGVkQXQ6IDEwMDAsXG4gICAgICAgIHVwZGF0ZWRBdDogMTAwMCxcbiAgICAgICAgbG9nUGF0aDogam9pbihiYXNlLCBcIi5nc2RcIiwgXCJkZWJ1Z1wiLCBcImxlZ2FjeS1uby1zcGVjaWFsaXN0LmxvZ1wiKSxcbiAgICAgICAgbGFzdEVycm9yOiBudWxsLFxuICAgICAgfTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihzZXNzaW9uc0RpciwgXCJsZWdhY3ktbm8tc3BlY2lhbGlzdC5qc29uXCIpLCBKU09OLnN0cmluZ2lmeShhcnRpZmFjdCwgbnVsbCwgMiksIFwidXRmLThcIik7XG5cbiAgICAgIGNvbnN0IGxvYWRlZCA9IGxvYWREZWJ1Z1Nlc3Npb24oYmFzZSwgXCJsZWdhY3ktbm8tc3BlY2lhbGlzdFwiKTtcbiAgICAgIGFzc2VydC5vayhsb2FkZWQgIT09IG51bGwsIFwibGVnYWN5IGFydGlmYWN0IHNob3VsZCBsb2FkIHN1Y2Nlc3NmdWxseVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChsb2FkZWQuc2Vzc2lvbi5zcGVjaWFsaXN0UmV2aWV3LCB1bmRlZmluZWQpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInZhbGlkYXRvciByZWplY3RzIHNwZWNpYWxpc3RSZXZpZXcgd2l0aCBtaXNzaW5nIHJlcXVpcmVkIGZpZWxkcyAoZW1wdHkgb2JqZWN0KVwiLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHNlc3Npb25zRGlyID0gZGVidWdTZXNzaW9uc0RpcihiYXNlKTtcbiAgICAgIG1rZGlyU3luYyhzZXNzaW9uc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBjb25zdCBhcnRpZmFjdCA9IHtcbiAgICAgICAgdmVyc2lvbjogMSxcbiAgICAgICAgbW9kZTogXCJkZWJ1Z1wiLFxuICAgICAgICBzbHVnOiBcImJhZC1zcGVjaWFsaXN0LWVtcHR5XCIsXG4gICAgICAgIGlzc3VlOiBcIkJhZCBzcGVjaWFsaXN0IHJldmlld1wiLFxuICAgICAgICBzdGF0dXM6IFwiYWN0aXZlXCIsXG4gICAgICAgIHBoYXNlOiBcInF1ZXVlZFwiLFxuICAgICAgICBjcmVhdGVkQXQ6IDEwMDAsXG4gICAgICAgIHVwZGF0ZWRBdDogMTAwMCxcbiAgICAgICAgbG9nUGF0aDogam9pbihiYXNlLCBcIi5nc2RcIiwgXCJkZWJ1Z1wiLCBcImJhZC1zcGVjaWFsaXN0LWVtcHR5LmxvZ1wiKSxcbiAgICAgICAgbGFzdEVycm9yOiBudWxsLFxuICAgICAgICBzcGVjaWFsaXN0UmV2aWV3OiB7fSxcbiAgICAgIH07XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4oc2Vzc2lvbnNEaXIsIFwiYmFkLXNwZWNpYWxpc3QtZW1wdHkuanNvblwiKSwgSlNPTi5zdHJpbmdpZnkoYXJ0aWZhY3QsIG51bGwsIDIpLCBcInV0Zi04XCIpO1xuXG4gICAgICBhc3NlcnQudGhyb3dzKFxuICAgICAgICAoKSA9PiBsb2FkRGVidWdTZXNzaW9uKGJhc2UsIFwiYmFkLXNwZWNpYWxpc3QtZW1wdHlcIiksXG4gICAgICAgIC9NYWxmb3JtZWQgZGVidWcgc2Vzc2lvbiBhcnRpZmFjdC8sXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInZhbGlkYXRvciByZWplY3RzIHNwZWNpYWxpc3RSZXZpZXcgd2l0aCB3cm9uZyBmaWVsZCB0eXBlcyAodmVyZGljdCBhcyBudW1iZXIsIHNraWxsIGFzIG51bWJlcilcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzZXNzaW9uc0RpciA9IGRlYnVnU2Vzc2lvbnNEaXIoYmFzZSk7XG4gICAgICBta2RpclN5bmMoc2Vzc2lvbnNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgY29uc3QgYXJ0aWZhY3QgPSB7XG4gICAgICAgIHZlcnNpb246IDEsXG4gICAgICAgIG1vZGU6IFwiZGVidWdcIixcbiAgICAgICAgc2x1ZzogXCJiYWQtc3BlY2lhbGlzdC10eXBlc1wiLFxuICAgICAgICBpc3N1ZTogXCJCYWQgc3BlY2lhbGlzdCB0eXBlc1wiLFxuICAgICAgICBzdGF0dXM6IFwiYWN0aXZlXCIsXG4gICAgICAgIHBoYXNlOiBcInF1ZXVlZFwiLFxuICAgICAgICBjcmVhdGVkQXQ6IDEwMDAsXG4gICAgICAgIHVwZGF0ZWRBdDogMTAwMCxcbiAgICAgICAgbG9nUGF0aDogam9pbihiYXNlLCBcIi5nc2RcIiwgXCJkZWJ1Z1wiLCBcImJhZC1zcGVjaWFsaXN0LXR5cGVzLmxvZ1wiKSxcbiAgICAgICAgbGFzdEVycm9yOiBudWxsLFxuICAgICAgICBzcGVjaWFsaXN0UmV2aWV3OiB7XG4gICAgICAgICAgaGludDogXCJDaGVjayBzb21ldGhpbmdcIixcbiAgICAgICAgICBza2lsbDogNDIsIC8vIHNob3VsZCBiZSBzdHJpbmd8bnVsbFxuICAgICAgICAgIHZlcmRpY3Q6IDEsIC8vIHNob3VsZCBiZSBzdHJpbmdcbiAgICAgICAgICBkZXRhaWw6IFwiU29tZSBkZXRhaWxcIixcbiAgICAgICAgICByZXZpZXdlZEF0OiAxNzAwMDAwMDAwLFxuICAgICAgICB9LFxuICAgICAgfTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihzZXNzaW9uc0RpciwgXCJiYWQtc3BlY2lhbGlzdC10eXBlcy5qc29uXCIpLCBKU09OLnN0cmluZ2lmeShhcnRpZmFjdCwgbnVsbCwgMiksIFwidXRmLThcIik7XG5cbiAgICAgIGFzc2VydC50aHJvd3MoXG4gICAgICAgICgpID0+IGxvYWREZWJ1Z1Nlc3Npb24oYmFzZSwgXCJiYWQtc3BlY2lhbGlzdC10eXBlc1wiKSxcbiAgICAgICAgL01hbGZvcm1lZCBkZWJ1ZyBzZXNzaW9uIGFydGlmYWN0LyxcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwidmFsaWRhdG9yIGFjY2VwdHMgc3BlY2lhbGlzdFJldmlldyB3aXRoIGV4dHJhIHVua25vd24gZmllbGRzIChmb3J3YXJkIGNvbXBhdClcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzZXNzaW9uc0RpciA9IGRlYnVnU2Vzc2lvbnNEaXIoYmFzZSk7XG4gICAgICBta2RpclN5bmMoc2Vzc2lvbnNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgY29uc3QgYXJ0aWZhY3QgPSB7XG4gICAgICAgIHZlcnNpb246IDEsXG4gICAgICAgIG1vZGU6IFwiZGVidWdcIixcbiAgICAgICAgc2x1ZzogXCJzcGVjaWFsaXN0LWV4dHJhLWZpZWxkc1wiLFxuICAgICAgICBpc3N1ZTogXCJTcGVjaWFsaXN0IHdpdGggZXh0cmEgZmllbGRzXCIsXG4gICAgICAgIHN0YXR1czogXCJhY3RpdmVcIixcbiAgICAgICAgcGhhc2U6IFwicXVldWVkXCIsXG4gICAgICAgIGNyZWF0ZWRBdDogMTAwMCxcbiAgICAgICAgdXBkYXRlZEF0OiAxMDAwLFxuICAgICAgICBsb2dQYXRoOiBqb2luKGJhc2UsIFwiLmdzZFwiLCBcImRlYnVnXCIsIFwic3BlY2lhbGlzdC1leHRyYS1maWVsZHMubG9nXCIpLFxuICAgICAgICBsYXN0RXJyb3I6IG51bGwsXG4gICAgICAgIHNwZWNpYWxpc3RSZXZpZXc6IHtcbiAgICAgICAgICBoaW50OiBcIkxvb2sgYXQgY2FjaGluZyBsYXllclwiLFxuICAgICAgICAgIHNraWxsOiBudWxsLFxuICAgICAgICAgIHZlcmRpY3Q6IFwiTE9PS1NfR09PRCAoY2FjaGUgaXMgY29ycmVjdGx5IGludmFsaWRhdGVkKVwiLFxuICAgICAgICAgIGRldGFpbDogXCJUVEwgaXMgc2V0IGFwcHJvcHJpYXRlbHkuXCIsXG4gICAgICAgICAgcmV2aWV3ZWRBdDogMTcwMDAwMDAwMixcbiAgICAgICAgICB1bmtub3duRnV0dXJlRmllbGQ6IFwic29tZS12YWx1ZVwiLCAvLyBleHRyYSBmaWVsZCBzaG91bGQgYmUgdG9sZXJhdGVkXG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHNlc3Npb25zRGlyLCBcInNwZWNpYWxpc3QtZXh0cmEtZmllbGRzLmpzb25cIiksIEpTT04uc3RyaW5naWZ5KGFydGlmYWN0LCBudWxsLCAyKSwgXCJ1dGYtOFwiKTtcblxuICAgICAgY29uc3QgbG9hZGVkID0gbG9hZERlYnVnU2Vzc2lvbihiYXNlLCBcInNwZWNpYWxpc3QtZXh0cmEtZmllbGRzXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGxvYWRlZCAhPT0gbnVsbCwgXCJhcnRpZmFjdCB3aXRoIGV4dHJhIGZpZWxkcyBzaG91bGQgbG9hZCBzdWNjZXNzZnVsbHlcIik7XG4gICAgICBhc3NlcnQuZXF1YWwobG9hZGVkLnNlc3Npb24uc3BlY2lhbGlzdFJldmlldz8uaGludCwgXCJMb29rIGF0IGNhY2hpbmcgbGF5ZXJcIik7XG4gICAgICBhc3NlcnQuZXF1YWwobG9hZGVkLnNlc3Npb24uc3BlY2lhbGlzdFJldmlldz8uc2tpbGwsIG51bGwpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sUUFBUSxnQkFBZ0I7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsWUFBWSxhQUFhLFdBQVcsY0FBYyxRQUFRLHFCQUFxQjtBQUN4RixTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBRXJCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUlLO0FBRVAsU0FBUyxXQUFtQjtBQUMxQixRQUFNLE9BQU8sWUFBWSxLQUFLLE9BQU8sR0FBRywwQkFBMEIsQ0FBQztBQUNuRSxZQUFVLEtBQUssTUFBTSxNQUFNLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNqRCxTQUFPO0FBQ1Q7QUFFQSxTQUFTLGdE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
