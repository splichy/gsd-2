import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, cleanup } from "./test-utils.js";
import {
  logWarning,
  logError,
  drainLogs,
  drainAndSummarize,
  peekLogs,
  hasErrors,
  hasWarnings,
  hasAnyIssues,
  summarizeLogs,
  formatForNotification,
  setLogBasePath,
  setStderrLoggingEnabled,
  _resetLogs
} from "../workflow-logger.js";
import {
  initNotificationStore,
  readNotifications,
  _resetNotificationStore
} from "../notification-store.js";
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
describe("workflow-logger", () => {
  beforeEach(() => {
    _resetLogs();
  });
  describe("accumulation", () => {
    test("logWarning adds an entry with severity warn", () => {
      logWarning("engine", "test warning");
      const entries = peekLogs();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].severity, "warn");
      assert.equal(entries[0].component, "engine");
      assert.equal(entries[0].message, "test warning");
      assert.match(entries[0].ts, ISO_RE);
    });
    test("logError adds an entry with severity error", () => {
      logError("intercept", "blocked write", { path: "/foo/STATE.md" });
      const entries = peekLogs();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].severity, "error");
      assert.equal(entries[0].component, "intercept");
      assert.deepEqual(entries[0].context, { path: "/foo/STATE.md" });
    });
    test("accumulates multiple entries in order", () => {
      logWarning("projection", "render failed");
      logError("intercept", "blocked write");
      logWarning("manifest", "write failed");
      assert.equal(peekLogs().length, 3);
      assert.equal(peekLogs()[0].component, "projection");
      assert.equal(peekLogs()[1].component, "intercept");
      assert.equal(peekLogs()[2].component, "manifest");
    });
    test("omits context field when not provided", () => {
      logWarning("engine", "no context");
      assert.equal("context" in peekLogs()[0], false);
    });
    test("omits context field when undefined is passed", () => {
      logWarning("engine", "no context", void 0);
      assert.equal("context" in peekLogs()[0], false);
    });
    test("context with special characters is stored as-is", () => {
      logError("tool", "failed", { path: '/foo/"quoted".md', msg: "line1\nline2" });
      assert.deepEqual(peekLogs()[0].context, {
        path: '/foo/"quoted".md',
        msg: "line1\nline2"
      });
    });
    test("ts field is a valid ISO 8601 timestamp", () => {
      logWarning("engine", "ts check");
      assert.match(peekLogs()[0].ts, ISO_RE);
    });
  });
  describe("drain", () => {
    test("returns all entries and clears buffer", () => {
      logWarning("engine", "w1");
      logError("engine", "e1");
      const drained = drainLogs();
      assert.equal(drained.length, 2);
      assert.equal(peekLogs().length, 0);
    });
    test("returns empty array when no entries", () => {
      assert.deepEqual(drainLogs(), []);
    });
    test("second drain returns empty array", () => {
      logWarning("engine", "w1");
      drainLogs();
      assert.deepEqual(drainLogs(), []);
    });
  });
  describe("drainAndSummarize", () => {
    test("returns summary and clears buffer atomically", () => {
      logError("intercept", "blocked");
      logWarning("projection", "render failed");
      const { logs, summary } = drainAndSummarize();
      assert.equal(logs.length, 2);
      assert.equal(peekLogs().length, 0);
      assert.ok(summary?.includes("1 error(s)"));
      assert.ok(summary?.includes("1 warning(s)"));
    });
    test("returns null summary when buffer is empty", () => {
      const { logs, summary } = drainAndSummarize();
      assert.deepEqual(logs, []);
      assert.equal(summary, null);
    });
  });
  describe("hasErrors / hasWarnings / hasAnyIssues", () => {
    test("hasErrors returns false when only warnings", () => {
      logWarning("engine", "just a warning");
      assert.equal(hasErrors(), false);
      assert.equal(hasWarnings(), true);
    });
    test("hasErrors returns true when errors present", () => {
      logWarning("engine", "warning");
      logError("intercept", "error");
      assert.equal(hasErrors(), true);
    });
    test("hasWarnings returns false when buffer empty", () => {
      assert.equal(hasWarnings(), false);
    });
    test("hasWarnings returns false when buffer contains only errors", () => {
      logError("intercept", "only an error");
      assert.equal(hasWarnings(), false);
      assert.equal(hasErrors(), true);
    });
    test("hasAnyIssues returns true for warnings only", () => {
      logWarning("engine", "warn");
      assert.equal(hasAnyIssues(), true);
    });
    test("hasAnyIssues returns true for errors only", () => {
      logError("engine", "err");
      assert.equal(hasAnyIssues(), true);
    });
    test("hasAnyIssues returns false when buffer empty", () => {
      assert.equal(hasAnyIssues(), false);
    });
  });
  describe("summarizeLogs", () => {
    test("returns null when empty", () => {
      assert.equal(summarizeLogs(), null);
    });
    test("summarizes errors and warnings separately", () => {
      logError("intercept", "blocked STATE.md");
      logWarning("projection", "render failed");
      logWarning("manifest", "write failed");
      const summary = summarizeLogs();
      assert.ok(summary.includes("1 error(s)"));
      assert.ok(summary.includes("blocked STATE.md"));
      assert.ok(summary.includes("2 warning(s)"));
    });
    test("only shows errors section when no warnings", () => {
      logError("intercept", "blocked");
      const summary = summarizeLogs();
      assert.ok(summary.includes("1 error(s)"));
      assert.ok(!summary.includes("warning"));
    });
    test("only shows warnings section when no errors", () => {
      logWarning("projection", "render degraded");
      logWarning("manifest", "write slow");
      const summary = summarizeLogs();
      assert.ok(summary.includes("2 warning(s)"));
      assert.ok(!summary.includes("error"));
    });
    test("does not clear buffer", () => {
      logError("intercept", "blocked");
      summarizeLogs();
      assert.equal(peekLogs().length, 1);
    });
  });
  describe("formatForNotification", () => {
    test("returns empty string for empty array", () => {
      assert.equal(formatForNotification([]), "");
    });
    test("formats single entry without line breaks", () => {
      logError("intercept", "blocked write");
      const entries = drainLogs();
      const formatted = formatForNotification(entries);
      assert.equal(formatted, "[intercept] blocked write");
    });
    test("formats multiple entries with line breaks", () => {
      logWarning("projection", "render failed");
      logError("intercept", "blocked write");
      const entries = drainLogs();
      const formatted = formatForNotification(entries);
      assert.ok(formatted.includes("[projection] render failed"));
      assert.ok(formatted.includes("[intercept] blocked write"));
      assert.ok(formatted.includes("\n"));
    });
    test("includes context fields in formatted output", () => {
      logError("tool", "failed", { cmd: "complete_task" });
      const entries = drainLogs();
      const formatted = formatForNotification(entries);
      assert.equal(formatted, "[tool] failed (cmd: complete_task)");
    });
    test("excludes error key from context to avoid redundancy", () => {
      logError("tool", "disk write failed", { error: "ENOSPC", path: "/tmp/foo" });
      const entries = drainLogs();
      const formatted = formatForNotification(entries);
      assert.ok(formatted.includes("path: /tmp/foo"));
      assert.ok(!formatted.includes("error: ENOSPC"));
    });
    test("formats entry without context unchanged", () => {
      logError("intercept", "blocked write");
      const entries = drainLogs();
      const formatted = formatForNotification(entries);
      assert.equal(formatted, "[intercept] blocked write");
    });
  });
  describe("audit log persistence", () => {
    let dir;
    beforeEach(() => {
      dir = makeTempDir("wl-audit-");
    });
    afterEach(() => {
      setLogBasePath("");
      _resetNotificationStore();
      cleanup(dir);
    });
    test("writes entry to .gsd/audit-log.jsonl after setLogBasePath", () => {
      setLogBasePath(dir);
      logError("engine", "audit test entry");
      const auditPath = join(dir, ".gsd", "audit-log.jsonl");
      assert.ok(existsSync(auditPath), "audit-log.jsonl should exist");
      const content = readFileSync(auditPath, "utf-8");
      const entry = JSON.parse(content.trim());
      assert.equal(entry.severity, "error");
      assert.equal(entry.component, "engine");
      assert.equal(entry.message, "audit test entry");
    });
    test("_resetLogs does not clear the audit base path", () => {
      setLogBasePath(dir);
      _resetLogs();
      logError("engine", "post-reset entry");
      const auditPath = join(dir, ".gsd", "audit-log.jsonl");
      assert.ok(existsSync(auditPath), "audit-log.jsonl should exist after _resetLogs");
      const content = readFileSync(auditPath, "utf-8");
      const entry = JSON.parse(content.trim());
      assert.equal(entry.message, "post-reset entry");
    });
  });
  describe("buffer limit", () => {
    test("caps at MAX_BUFFER entries, dropping oldest", () => {
      const OVER = 110;
      const MAX = 100;
      for (let i = 0; i < OVER; i++) {
        logWarning("engine", `msg-${i}`);
      }
      const entries = peekLogs();
      assert.equal(entries.length, MAX);
      assert.equal(entries[0].message, `msg-${OVER - MAX}`);
      assert.equal(entries[MAX - 1].message, `msg-${OVER - 1}`);
    });
  });
  describe("new log components (db, dispatch)", () => {
    test("logError with 'db' component stores correct component", () => {
      logError("db", "failed to copy DB to worktree", { error: "ENOENT" });
      const entries = peekLogs();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].severity, "error");
      assert.equal(entries[0].component, "db");
      assert.equal(entries[0].message, "failed to copy DB to worktree");
      assert.deepEqual(entries[0].context, { error: "ENOENT" });
    });
    test("logError with 'dispatch' component stores correct component", () => {
      logError("dispatch", "reactive graph derivation failed", { error: "timeout" });
      const entries = peekLogs();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].severity, "error");
      assert.equal(entries[0].component, "dispatch");
      assert.deepEqual(entries[0].context, { error: "timeout" });
    });
    test("logWarning with 'reconcile' component for centralized logging path", () => {
      logWarning("reconcile", "could not acquire sync lock \u2014 another reconciliation may be in progress");
      const entries = peekLogs();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].severity, "warn");
      assert.equal(entries[0].component, "reconcile");
    });
    test("summarizeLogs includes db and dispatch entries", () => {
      logError("db", "worktree DB reconciliation failed: path contains unsafe characters");
      logWarning("dispatch", "graph derivation timeout");
      const summary = summarizeLogs();
      assert.ok(summary.includes("1 error(s)"));
      assert.ok(summary.includes("1 warning(s)"));
      assert.ok(summary.includes("unsafe characters"));
      assert.ok(summary.includes("graph derivation timeout"));
    });
    test("formatForNotification renders db and dispatch components", () => {
      logError("db", "copy failed");
      logWarning("dispatch", "slow derivation");
      const entries = drainLogs();
      const formatted = formatForNotification(entries);
      assert.ok(formatted.includes("[db] copy failed"));
      assert.ok(formatted.includes("[dispatch] slow derivation"));
    });
  });
  describe("stderr output", () => {
    test("keeps warnings out of stderr but persists them to notifications", (t) => {
      const dir = makeTempDir("wl-notify-");
      const written = [];
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk) => {
        written.push(chunk);
        return true;
      };
      t.after(() => {
        process.stderr.write = orig;
        _resetNotificationStore();
        cleanup(dir);
      });
      initNotificationStore(dir);
      logWarning("engine", "test warn");
      assert.deepEqual(written, []);
      const notifications = readNotifications(dir);
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].severity, "warning");
      assert.equal(notifications[0].message, "[engine] test warn");
    });
    test("writes ERROR prefix to stderr for errors", (t) => {
      const written = [];
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk) => {
        written.push(chunk);
        return true;
      };
      t.after(() => {
        process.stderr.write = orig;
      });
      logError("intercept", "blocked");
      assert.ok(written[0].includes("[gsd:intercept] ERROR: blocked"));
    });
    test("includes serialized context in stderr output", (t) => {
      const written = [];
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk) => {
        written.push(chunk);
        return true;
      };
      t.after(() => {
        process.stderr.write = orig;
      });
      logError("tool", "failed", { cmd: "complete_task" });
      assert.ok(written[0].includes('"cmd":"complete_task"'));
    });
    test("suppresses stderr when disabled", (t) => {
      const written = [];
      const orig = process.stderr.write.bind(process.stderr);
      const previous = setStderrLoggingEnabled(false);
      process.stderr.write = (chunk) => {
        written.push(chunk);
        return true;
      };
      t.after(() => {
        process.stderr.write = orig;
        setStderrLoggingEnabled(previous);
      });
      logWarning("engine", "hidden warning");
      assert.deepEqual(written, []);
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrZmxvdy1sb2dnZXIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEIEV4dGVuc2lvbiBcdTIwMTQgV29ya2Zsb3cgTG9nZ2VyIFRlc3RzXG4vLyBUZXN0cyBmb3IgdGhlIGNlbnRyYWxpemVkIHdhcm5pbmcvZXJyb3IgYWNjdW11bGF0b3IuXG5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0LCBiZWZvcmVFYWNoLCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgbWFrZVRlbXBEaXIsIGNsZWFudXAgfSBmcm9tIFwiLi90ZXN0LXV0aWxzLnRzXCI7XG5pbXBvcnQge1xuICBsb2dXYXJuaW5nLFxuICBsb2dFcnJvcixcbiAgZHJhaW5Mb2dzLFxuICBkcmFpbkFuZFN1bW1hcml6ZSxcbiAgcGVla0xvZ3MsXG4gIGhhc0Vycm9ycyxcbiAgaGFzV2FybmluZ3MsXG4gIGhhc0FueUlzc3VlcyxcbiAgc3VtbWFyaXplTG9ncyxcbiAgZm9ybWF0Rm9yTm90aWZpY2F0aW9uLFxuICBzZXRMb2dCYXNlUGF0aCxcbiAgc2V0U3RkZXJyTG9nZ2luZ0VuYWJsZWQsXG4gIF9yZXNldExvZ3MsXG59IGZyb20gXCIuLi93b3JrZmxvdy1sb2dnZXIudHNcIjtcbmltcG9ydCB7XG4gIGluaXROb3RpZmljYXRpb25TdG9yZSxcbiAgcmVhZE5vdGlmaWNhdGlvbnMsXG4gIF9yZXNldE5vdGlmaWNhdGlvblN0b3JlLFxufSBmcm9tIFwiLi4vbm90aWZpY2F0aW9uLXN0b3JlLnRzXCI7XG5cbmNvbnN0IElTT19SRSA9IC9eXFxkezR9LVxcZHsyfS1cXGR7Mn1UXFxkezJ9OlxcZHsyfTpcXGR7Mn1cXC5cXGR7M31aJC87XG5cbmRlc2NyaWJlKFwid29ya2Zsb3ctbG9nZ2VyXCIsICgpID0+IHtcbiAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgX3Jlc2V0TG9ncygpO1xuICB9KTtcblxuICBkZXNjcmliZShcImFjY3VtdWxhdGlvblwiLCAoKSA9PiB7XG4gICAgdGVzdChcImxvZ1dhcm5pbmcgYWRkcyBhbiBlbnRyeSB3aXRoIHNldmVyaXR5IHdhcm5cIiwgKCkgPT4ge1xuICAgICAgbG9nV2FybmluZyhcImVuZ2luZVwiLCBcInRlc3Qgd2FybmluZ1wiKTtcbiAgICAgIGNvbnN0IGVudHJpZXMgPSBwZWVrTG9ncygpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGVudHJpZXMubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChlbnRyaWVzWzBdLnNldmVyaXR5LCBcIndhcm5cIik7XG4gICAgICBhc3NlcnQuZXF1YWwoZW50cmllc1swXS5jb21wb25lbnQsIFwiZW5naW5lXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGVudHJpZXNbMF0ubWVzc2FnZSwgXCJ0ZXN0IHdhcm5pbmdcIik7XG4gICAgICBhc3NlcnQubWF0Y2goZW50cmllc1swXS50cywgSVNPX1JFKTtcbiAgICB9KTtcblxuICAgIHRlc3QoXCJsb2dFcnJvciBhZGRzIGFuIGVudHJ5IHdpdGggc2V2ZXJpdHkgZXJyb3JcIiwgKCkgPT4ge1xuICAgICAgbG9nRXJyb3IoXCJpbnRlcmNlcHRcIiwgXCJibG9ja2VkIHdyaXRlXCIsIHsgcGF0aDogXCIvZm9vL1NUQVRFLm1kXCIgfSk7XG4gICAgICBjb25zdCBlbnRyaWVzID0gcGVla0xvZ3MoKTtcbiAgICAgIGFzc2VydC5lcXVhbChlbnRyaWVzLmxlbmd0aCwgMSk7XG4gICAgICBhc3NlcnQuZXF1YWwoZW50cmllc1swXS5zZXZlcml0eSwgXCJlcnJvclwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChlbnRyaWVzWzBdLmNvbXBvbmVudCwgXCJpbnRlcmNlcHRcIik7XG4gICAgICBhc3NlcnQuZGVlcEVxdWFsKGVudHJpZXNbMF0uY29udGV4dCwgeyBwYXRoOiBcIi9mb28vU1RBVEUubWRcIiB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoXCJhY2N1bXVsYXRlcyBtdWx0aXBsZSBlbnRyaWVzIGluIG9yZGVyXCIsICgpID0+IHtcbiAgICAgIGxvZ1dhcm5pbmcoXCJwcm9qZWN0aW9uXCIsIFwicmVuZGVyIGZhaWxlZFwiKTtcbiAgICAgIGxvZ0Vycm9yKFwiaW50ZXJjZXB0XCIsIFwiYmxvY2tlZCB3cml0ZVwiKTtcbiAgICAgIGxvZ1dhcm5pbmcoXCJtYW5pZmVzdFwiLCBcIndyaXRlIGZhaWxlZFwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChwZWVrTG9ncygpLmxlbmd0aCwgMyk7XG4gICAgICBhc3NlcnQuZXF1YWwocGVla0xvZ3MoKVswXS5jb21wb25lbnQsIFwicHJvamVjdGlvblwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChwZWVrTG9ncygpWzFdLmNvbXBvbmVudCwgXCJpbnRlcmNlcHRcIik7XG4gICAgICBhc3NlcnQuZXF1YWwocGVla0xvZ3MoKVsyXS5jb21wb25lbnQsIFwibWFuaWZlc3RcIik7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwib21pdHMgY29udGV4dCBmaWVsZCB3aGVuIG5vdCBwcm92aWRlZFwiLCAoKSA9PiB7XG4gICAgICBsb2dXYXJuaW5nKFwiZW5naW5lXCIsIFwibm8gY29udGV4dFwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChcImNvbnRleHRcIiBpbiBwZWVrTG9ncygpWzBdLCBmYWxzZSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwib21pdHMgY29udGV4dCBmaWVsZCB3aGVuIHVuZGVmaW5lZCBpcyBwYXNzZWRcIiwgKCkgPT4ge1xuICAgICAgbG9nV2FybmluZyhcImVuZ2luZVwiLCBcIm5vIGNvbnRleHRcIiwgdW5kZWZpbmVkKTtcbiAgICAgIGFzc2VydC5lcXVhbChcImNvbnRleHRcIiBpbiBwZWVrTG9ncygpWzBdLCBmYWxzZSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiY29udGV4dCB3aXRoIHNwZWNpYWwgY2hhcmFjdGVycyBpcyBzdG9yZWQgYXMtaXNcIiwgKCkgPT4ge1xuICAgICAgbG9nRXJyb3IoXCJ0b29sXCIsIFwiZmFpbGVkXCIsIHsgcGF0aDogJy9mb28vXCJxdW90ZWRcIi5tZCcsIG1zZzogXCJsaW5lMVxcbmxpbmUyXCIgfSk7XG4gICAgICBhc3NlcnQuZGVlcEVxdWFsKHBlZWtMb2dzKClbMF0uY29udGV4dCwge1xuICAgICAgICBwYXRoOiAnL2Zvby9cInF1b3RlZFwiLm1kJyxcbiAgICAgICAgbXNnOiBcImxpbmUxXFxubGluZTJcIixcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdChcInRzIGZpZWxkIGlzIGEgdmFsaWQgSVNPIDg2MDEgdGltZXN0YW1wXCIsICgpID0+IHtcbiAgICAgIGxvZ1dhcm5pbmcoXCJlbmdpbmVcIiwgXCJ0cyBjaGVja1wiKTtcbiAgICAgIGFzc2VydC5tYXRjaChwZWVrTG9ncygpWzBdLnRzLCBJU09fUkUpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZShcImRyYWluXCIsICgpID0+IHtcbiAgICB0ZXN0KFwicmV0dXJucyBhbGwgZW50cmllcyBhbmQgY2xlYXJzIGJ1ZmZlclwiLCAoKSA9PiB7XG4gICAgICBsb2dXYXJuaW5nKFwiZW5naW5lXCIsIFwidzFcIik7XG4gICAgICBsb2dFcnJvcihcImVuZ2luZVwiLCBcImUxXCIpO1xuICAgICAgY29uc3QgZHJhaW5lZCA9IGRyYWluTG9ncygpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGRyYWluZWQubGVuZ3RoLCAyKTtcbiAgICAgIGFzc2VydC5lcXVhbChwZWVrTG9ncygpLmxlbmd0aCwgMCk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwicmV0dXJucyBlbXB0eSBhcnJheSB3aGVuIG5vIGVudHJpZXNcIiwgKCkgPT4ge1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChkcmFpbkxvZ3MoKSwgW10pO1xuICAgIH0pO1xuXG4gICAgdGVzdChcInNlY29uZCBkcmFpbiByZXR1cm5zIGVtcHR5IGFycmF5XCIsICgpID0+IHtcbiAgICAgIGxvZ1dhcm5pbmcoXCJlbmdpbmVcIiwgXCJ3MVwiKTtcbiAgICAgIGRyYWluTG9ncygpO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChkcmFpbkxvZ3MoKSwgW10pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZShcImRyYWluQW5kU3VtbWFyaXplXCIsICgpID0+IHtcbiAgICB0ZXN0KFwicmV0dXJucyBzdW1tYXJ5IGFuZCBjbGVhcnMgYnVmZmVyIGF0b21pY2FsbHlcIiwgKCkgPT4ge1xuICAgICAgbG9nRXJyb3IoXCJpbnRlcmNlcHRcIiwgXCJibG9ja2VkXCIpO1xuICAgICAgbG9nV2FybmluZyhcInByb2plY3Rpb25cIiwgXCJyZW5kZXIgZmFpbGVkXCIpO1xuICAgICAgY29uc3QgeyBsb2dzLCBzdW1tYXJ5IH0gPSBkcmFpbkFuZFN1bW1hcml6ZSgpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGxvZ3MubGVuZ3RoLCAyKTtcbiAgICAgIGFzc2VydC5lcXVhbChwZWVrTG9ncygpLmxlbmd0aCwgMCk7XG4gICAgICBhc3NlcnQub2soc3VtbWFyeT8uaW5jbHVkZXMoXCIxIGVycm9yKHMpXCIpKTtcbiAgICAgIGFzc2VydC5vayhzdW1tYXJ5Py5pbmNsdWRlcyhcIjEgd2FybmluZyhzKVwiKSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwicmV0dXJucyBudWxsIHN1bW1hcnkgd2hlbiBidWZmZXIgaXMgZW1wdHlcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgeyBsb2dzLCBzdW1tYXJ5IH0gPSBkcmFpbkFuZFN1bW1hcml6ZSgpO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChsb2dzLCBbXSk7XG4gICAgICBhc3NlcnQuZXF1YWwoc3VtbWFyeSwgbnVsbCk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKFwiaGFzRXJyb3JzIC8gaGFzV2FybmluZ3MgLyBoYXNBbnlJc3N1ZXNcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJoYXNFcnJvcnMgcmV0dXJucyBmYWxzZSB3aGVuIG9ubHkgd2FybmluZ3NcIiwgKCkgPT4ge1xuICAgICAgbG9nV2FybmluZyhcImVuZ2luZVwiLCBcImp1c3QgYSB3YXJuaW5nXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGhhc0Vycm9ycygpLCBmYWxzZSk7XG4gICAgICBhc3NlcnQuZXF1YWwoaGFzV2FybmluZ3MoKSwgdHJ1ZSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiaGFzRXJyb3JzIHJldHVybnMgdHJ1ZSB3aGVuIGVycm9ycyBwcmVzZW50XCIsICgpID0+IHtcbiAgICAgIGxvZ1dhcm5pbmcoXCJlbmdpbmVcIiwgXCJ3YXJuaW5nXCIpO1xuICAgICAgbG9nRXJyb3IoXCJpbnRlcmNlcHRcIiwgXCJlcnJvclwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChoYXNFcnJvcnMoKSwgdHJ1ZSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiaGFzV2FybmluZ3MgcmV0dXJucyBmYWxzZSB3aGVuIGJ1ZmZlciBlbXB0eVwiLCAoKSA9PiB7XG4gICAgICBhc3NlcnQuZXF1YWwoaGFzV2FybmluZ3MoKSwgZmFsc2UpO1xuICAgIH0pO1xuXG4gICAgdGVzdChcImhhc1dhcm5pbmdzIHJldHVybnMgZmFsc2Ugd2hlbiBidWZmZXIgY29udGFpbnMgb25seSBlcnJvcnNcIiwgKCkgPT4ge1xuICAgICAgbG9nRXJyb3IoXCJpbnRlcmNlcHRcIiwgXCJvbmx5IGFuIGVycm9yXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGhhc1dhcm5pbmdzKCksIGZhbHNlKTtcbiAgICAgIGFzc2VydC5lcXVhbChoYXNFcnJvcnMoKSwgdHJ1ZSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiaGFzQW55SXNzdWVzIHJldHVybnMgdHJ1ZSBmb3Igd2FybmluZ3Mgb25seVwiLCAoKSA9PiB7XG4gICAgICBsb2dXYXJuaW5nKFwiZW5naW5lXCIsIFwid2FyblwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChoYXNBbnlJc3N1ZXMoKSwgdHJ1ZSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiaGFzQW55SXNzdWVzIHJldHVybnMgdHJ1ZSBmb3IgZXJyb3JzIG9ubHlcIiwgKCkgPT4ge1xuICAgICAgbG9nRXJyb3IoXCJlbmdpbmVcIiwgXCJlcnJcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoaGFzQW55SXNzdWVzKCksIHRydWUpO1xuICAgIH0pO1xuXG4gICAgdGVzdChcImhhc0FueUlzc3VlcyByZXR1cm5zIGZhbHNlIHdoZW4gYnVmZmVyIGVtcHR5XCIsICgpID0+IHtcbiAgICAgIGFzc2VydC5lcXVhbChoYXNBbnlJc3N1ZXMoKSwgZmFsc2UpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZShcInN1bW1hcml6ZUxvZ3NcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJyZXR1cm5zIG51bGwgd2hlbiBlbXB0eVwiLCAoKSA9PiB7XG4gICAgICBhc3NlcnQuZXF1YWwoc3VtbWFyaXplTG9ncygpLCBudWxsKTtcbiAgICB9KTtcblxuICAgIHRlc3QoXCJzdW1tYXJpemVzIGVycm9ycyBhbmQgd2FybmluZ3Mgc2VwYXJhdGVseVwiLCAoKSA9PiB7XG4gICAgICBsb2dFcnJvcihcImludGVyY2VwdFwiLCBcImJsb2NrZWQgU1RBVEUubWRcIik7XG4gICAgICBsb2dXYXJuaW5nKFwicHJvamVjdGlvblwiLCBcInJlbmRlciBmYWlsZWRcIik7XG4gICAgICBsb2dXYXJuaW5nKFwibWFuaWZlc3RcIiwgXCJ3cml0ZSBmYWlsZWRcIik7XG4gICAgICBjb25zdCBzdW1tYXJ5ID0gc3VtbWFyaXplTG9ncygpITtcbiAgICAgIGFzc2VydC5vayhzdW1tYXJ5LmluY2x1ZGVzKFwiMSBlcnJvcihzKVwiKSk7XG4gICAgICBhc3NlcnQub2soc3VtbWFyeS5pbmNsdWRlcyhcImJsb2NrZWQgU1RBVEUubWRcIikpO1xuICAgICAgYXNzZXJ0Lm9rKHN1bW1hcnkuaW5jbHVkZXMoXCIyIHdhcm5pbmcocylcIikpO1xuICAgIH0pO1xuXG4gICAgdGVzdChcIm9ubHkgc2hvd3MgZXJyb3JzIHNlY3Rpb24gd2hlbiBubyB3YXJuaW5nc1wiLCAoKSA9PiB7XG4gICAgICBsb2dFcnJvcihcImludGVyY2VwdFwiLCBcImJsb2NrZWRcIik7XG4gICAgICBjb25zdCBzdW1tYXJ5ID0gc3VtbWFyaXplTG9ncygpITtcbiAgICAgIGFzc2VydC5vayhzdW1tYXJ5LmluY2x1ZGVzKFwiMSBlcnJvcihzKVwiKSk7XG4gICAgICBhc3NlcnQub2soIXN1bW1hcnkuaW5jbHVkZXMoXCJ3YXJuaW5nXCIpKTtcbiAgICB9KTtcblxuICAgIHRlc3QoXCJvbmx5IHNob3dzIHdhcm5pbmdzIHNlY3Rpb24gd2hlbiBubyBlcnJvcnNcIiwgKCkgPT4ge1xuICAgICAgbG9nV2FybmluZyhcInByb2plY3Rpb25cIiwgXCJyZW5kZXIgZGVncmFkZWRcIik7XG4gICAgICBsb2dXYXJuaW5nKFwibWFuaWZlc3RcIiwgXCJ3cml0ZSBzbG93XCIpO1xuICAgICAgY29uc3Qgc3VtbWFyeSA9IHN1bW1hcml6ZUxvZ3MoKSE7XG4gICAgICBhc3NlcnQub2soc3VtbWFyeS5pbmNsdWRlcyhcIjIgd2FybmluZyhzKVwiKSk7XG4gICAgICBhc3NlcnQub2soIXN1bW1hcnkuaW5jbHVkZXMoXCJlcnJvclwiKSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiZG9lcyBub3QgY2xlYXIgYnVmZmVyXCIsICgpID0+IHtcbiAgICAgIGxvZ0Vycm9yKFwiaW50ZXJjZXB0XCIsIFwiYmxvY2tlZFwiKTtcbiAgICAgIHN1bW1hcml6ZUxvZ3MoKTtcbiAgICAgIGFzc2VydC5lcXVhbChwZWVrTG9ncygpLmxlbmd0aCwgMSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKFwiZm9ybWF0Rm9yTm90aWZpY2F0aW9uXCIsICgpID0+IHtcbiAgICB0ZXN0KFwicmV0dXJucyBlbXB0eSBzdHJpbmcgZm9yIGVtcHR5IGFycmF5XCIsICgpID0+IHtcbiAgICAgIGFzc2VydC5lcXVhbChmb3JtYXRGb3JOb3RpZmljYXRpb24oW10pLCBcIlwiKTtcbiAgICB9KTtcblxuICAgIHRlc3QoXCJmb3JtYXRzIHNpbmdsZSBlbnRyeSB3aXRob3V0IGxpbmUgYnJlYWtzXCIsICgpID0+IHtcbiAgICAgIGxvZ0Vycm9yKFwiaW50ZXJjZXB0XCIsIFwiYmxvY2tlZCB3cml0ZVwiKTtcbiAgICAgIGNvbnN0IGVudHJpZXMgPSBkcmFpbkxvZ3MoKTtcbiAgICAgIGNvbnN0IGZvcm1hdHRlZCA9IGZvcm1hdEZvck5vdGlmaWNhdGlvbihlbnRyaWVzKTtcbiAgICAgIGFzc2VydC5lcXVhbChmb3JtYXR0ZWQsIFwiW2ludGVyY2VwdF0gYmxvY2tlZCB3cml0ZVwiKTtcbiAgICB9KTtcblxuICAgIHRlc3QoXCJmb3JtYXRzIG11bHRpcGxlIGVudHJpZXMgd2l0aCBsaW5lIGJyZWFrc1wiLCAoKSA9PiB7XG4gICAgICBsb2dXYXJuaW5nKFwicHJvamVjdGlvblwiLCBcInJlbmRlciBmYWlsZWRcIik7XG4gICAgICBsb2dFcnJvcihcImludGVyY2VwdFwiLCBcImJsb2NrZWQgd3JpdGVcIik7XG4gICAgICBjb25zdCBlbnRyaWVzID0gZHJhaW5Mb2dzKCk7XG4gICAgICBjb25zdCBmb3JtYXR0ZWQgPSBmb3JtYXRGb3JOb3RpZmljYXRpb24oZW50cmllcyk7XG4gICAgICBhc3NlcnQub2soZm9ybWF0dGVkLmluY2x1ZGVzKFwiW3Byb2plY3Rpb25dIHJlbmRlciBmYWlsZWRcIikpO1xuICAgICAgYXNzZXJ0Lm9rKGZvcm1hdHRlZC5pbmNsdWRlcyhcIltpbnRlcmNlcHRdIGJsb2NrZWQgd3JpdGVcIikpO1xuICAgICAgYXNzZXJ0Lm9rKGZvcm1hdHRlZC5pbmNsdWRlcyhcIlxcblwiKSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiaW5jbHVkZXMgY29udGV4dCBmaWVsZHMgaW4gZm9ybWF0dGVkIG91dHB1dFwiLCAoKSA9PiB7XG4gICAgICBsb2dFcnJvcihcInRvb2xcIiwgXCJmYWlsZWRcIiwgeyBjbWQ6IFwiY29tcGxldGVfdGFza1wiIH0pO1xuICAgICAgY29uc3QgZW50cmllcyA9IGRyYWluTG9ncygpO1xuICAgICAgY29uc3QgZm9ybWF0dGVkID0gZm9ybWF0Rm9yTm90aWZpY2F0aW9uKGVudHJpZXMpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGZvcm1hdHRlZCwgXCJbdG9vbF0gZmFpbGVkIChjbWQ6IGNvbXBsZXRlX3Rhc2spXCIpO1xuICAgIH0pO1xuXG4gICAgdGVzdChcImV4Y2x1ZGVzIGVycm9yIGtleSBmcm9tIGNvbnRleHQgdG8gYXZvaWQgcmVkdW5kYW5jeVwiLCAoKSA9PiB7XG4gICAgICBsb2dFcnJvcihcInRvb2xcIiwgXCJkaXNrIHdyaXRlIGZhaWxlZFwiLCB7IGVycm9yOiBcIkVOT1NQQ1wiLCBwYXRoOiBcIi90bXAvZm9vXCIgfSk7XG4gICAgICBjb25zdCBlbnRyaWVzID0gZHJhaW5Mb2dzKCk7XG4gICAgICBjb25zdCBmb3JtYXR0ZWQgPSBmb3JtYXRGb3JOb3RpZmljYXRpb24oZW50cmllcyk7XG4gICAgICBhc3NlcnQub2soZm9ybWF0dGVkLmluY2x1ZGVzKFwicGF0aDogL3RtcC9mb29cIikpO1xuICAgICAgYXNzZXJ0Lm9rKCFmb3JtYXR0ZWQuaW5jbHVkZXMoXCJlcnJvcjogRU5PU1BDXCIpKTtcbiAgICB9KTtcblxuICAgIHRlc3QoXCJmb3JtYXRzIGVudHJ5IHdpdGhvdXQgY29udGV4dCB1bmNoYW5nZWRcIiwgKCkgPT4ge1xuICAgICAgbG9nRXJyb3IoXCJpbnRlcmNlcHRcIiwgXCJibG9ja2VkIHdyaXRlXCIpO1xuICAgICAgY29uc3QgZW50cmllcyA9IGRyYWluTG9ncygpO1xuICAgICAgY29uc3QgZm9ybWF0dGVkID0gZm9ybWF0Rm9yTm90aWZpY2F0aW9uKGVudHJpZXMpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGZvcm1hdHRlZCwgXCJbaW50ZXJjZXB0XSBibG9ja2VkIHdyaXRlXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZShcImF1ZGl0IGxvZyBwZXJzaXN0ZW5jZVwiLCAoKSA9PiB7XG4gICAgbGV0IGRpcjogc3RyaW5nO1xuXG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBkaXIgPSBtYWtlVGVtcERpcihcIndsLWF1ZGl0LVwiKTtcbiAgICB9KTtcblxuICAgIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgICBzZXRMb2dCYXNlUGF0aChcIlwiKTtcbiAgICAgIF9yZXNldE5vdGlmaWNhdGlvblN0b3JlKCk7XG4gICAgICBjbGVhbnVwKGRpcik7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwid3JpdGVzIGVudHJ5IHRvIC5nc2QvYXVkaXQtbG9nLmpzb25sIGFmdGVyIHNldExvZ0Jhc2VQYXRoXCIsICgpID0+IHtcbiAgICAgIHNldExvZ0Jhc2VQYXRoKGRpcik7XG4gICAgICBsb2dFcnJvcihcImVuZ2luZVwiLCBcImF1ZGl0IHRlc3QgZW50cnlcIik7XG5cbiAgICAgIGNvbnN0IGF1ZGl0UGF0aCA9IGpvaW4oZGlyLCBcIi5nc2RcIiwgXCJhdWRpdC1sb2cuanNvbmxcIik7XG4gICAgICBhc3NlcnQub2soZXhpc3RzU3luYyhhdWRpdFBhdGgpLCBcImF1ZGl0LWxvZy5qc29ubCBzaG91bGQgZXhpc3RcIik7XG4gICAgICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGF1ZGl0UGF0aCwgXCJ1dGYtOFwiKTtcbiAgICAgIGNvbnN0IGVudHJ5ID0gSlNPTi5wYXJzZShjb250ZW50LnRyaW0oKSk7XG4gICAgICBhc3NlcnQuZXF1YWwoZW50cnkuc2V2ZXJpdHksIFwiZXJyb3JcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoZW50cnkuY29tcG9uZW50LCBcImVuZ2luZVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChlbnRyeS5tZXNzYWdlLCBcImF1ZGl0IHRlc3QgZW50cnlcIik7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiX3Jlc2V0TG9ncyBkb2VzIG5vdCBjbGVhciB0aGUgYXVkaXQgYmFzZSBwYXRoXCIsICgpID0+IHtcbiAgICAgIHNldExvZ0Jhc2VQYXRoKGRpcik7XG4gICAgICBfcmVzZXRMb2dzKCk7XG4gICAgICBsb2dFcnJvcihcImVuZ2luZVwiLCBcInBvc3QtcmVzZXQgZW50cnlcIik7XG5cbiAgICAgIGNvbnN0IGF1ZGl0UGF0aCA9IGpvaW4oZGlyLCBcIi5nc2RcIiwgXCJhdWRpdC1sb2cuanNvbmxcIik7XG4gICAgICBhc3NlcnQub2soZXhpc3RzU3luYyhhdWRpdFBhdGgpLCBcImF1ZGl0LWxvZy5qc29ubCBzaG91bGQgZXhpc3QgYWZ0ZXIgX3Jlc2V0TG9nc1wiKTtcbiAgICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoYXVkaXRQYXRoLCBcInV0Zi04XCIpO1xuICAgICAgY29uc3QgZW50cnkgPSBKU09OLnBhcnNlKGNvbnRlbnQudHJpbSgpKTtcbiAgICAgIGFzc2VydC5lcXVhbChlbnRyeS5tZXNzYWdlLCBcInBvc3QtcmVzZXQgZW50cnlcIik7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKFwiYnVmZmVyIGxpbWl0XCIsICgpID0+IHtcbiAgICB0ZXN0KFwiY2FwcyBhdCBNQVhfQlVGRkVSIGVudHJpZXMsIGRyb3BwaW5nIG9sZGVzdFwiLCAoKSA9PiB7XG4gICAgICBjb25zdCBPVkVSID0gMTEwO1xuICAgICAgY29uc3QgTUFYID0gMTAwO1xuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBPVkVSOyBpKyspIHtcbiAgICAgICAgbG9nV2FybmluZyhcImVuZ2luZVwiLCBgbXNnLSR7aX1gKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGVudHJpZXMgPSBwZWVrTG9ncygpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGVudHJpZXMubGVuZ3RoLCBNQVgpO1xuICAgICAgLy8gRmlyc3QgTUFYIGVudHJpZXMgZHJvcHBlZDsgb2xkZXN0IHN1cnZpdmluZyA9IG1zZy0oT1ZFUi1NQVgpXG4gICAgICBhc3NlcnQuZXF1YWwoZW50cmllc1swXS5tZXNzYWdlLCBgbXNnLSR7T1ZFUiAtIE1BWH1gKTtcbiAgICAgIGFzc2VydC5lcXVhbChlbnRyaWVzW01BWCAtIDFdLm1lc3NhZ2UsIGBtc2ctJHtPVkVSIC0gMX1gKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoXCJuZXcgbG9nIGNvbXBvbmVudHMgKGRiLCBkaXNwYXRjaClcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJsb2dFcnJvciB3aXRoICdkYicgY29tcG9uZW50IHN0b3JlcyBjb3JyZWN0IGNvbXBvbmVudFwiLCAoKSA9PiB7XG4gICAgICBsb2dFcnJvcihcImRiXCIsIFwiZmFpbGVkIHRvIGNvcHkgREIgdG8gd29ya3RyZWVcIiwgeyBlcnJvcjogXCJFTk9FTlRcIiB9KTtcbiAgICAgIGNvbnN0IGVudHJpZXMgPSBwZWVrTG9ncygpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGVudHJpZXMubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChlbnRyaWVzWzBdLnNldmVyaXR5LCBcImVycm9yXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGVudHJpZXNbMF0uY29tcG9uZW50LCBcImRiXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGVudHJpZXNbMF0ubWVzc2FnZSwgXCJmYWlsZWQgdG8gY29weSBEQiB0byB3b3JrdHJlZVwiKTtcbiAgICAgIGFzc2VydC5kZWVwRXF1YWwoZW50cmllc1swXS5jb250ZXh0LCB7IGVycm9yOiBcIkVOT0VOVFwiIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdChcImxvZ0Vycm9yIHdpdGggJ2Rpc3BhdGNoJyBjb21wb25lbnQgc3RvcmVzIGNvcnJlY3QgY29tcG9uZW50XCIsICgpID0+IHtcbiAgICAgIGxvZ0Vycm9yKFwiZGlzcGF0Y2hcIiwgXCJyZWFjdGl2ZSBncmFwaCBkZXJpdmF0aW9uIGZhaWxlZFwiLCB7IGVycm9yOiBcInRpbWVvdXRcIiB9KTtcbiAgICAgIGNvbnN0IGVudHJpZXMgPSBwZWVrTG9ncygpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGVudHJpZXMubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChlbnRyaWVzWzBdLnNldmVyaXR5LCBcImVycm9yXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGVudHJpZXNbMF0uY29tcG9uZW50LCBcImRpc3BhdGNoXCIpO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChlbnRyaWVzWzBdLmNvbnRleHQsIHsgZXJyb3I6IFwidGltZW91dFwiIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdChcImxvZ1dhcm5pbmcgd2l0aCAncmVjb25jaWxlJyBjb21wb25lbnQgZm9yIGNlbnRyYWxpemVkIGxvZ2dpbmcgcGF0aFwiLCAoKSA9PiB7XG4gICAgICBsb2dXYXJuaW5nKFwicmVjb25jaWxlXCIsIFwiY291bGQgbm90IGFjcXVpcmUgc3luYyBsb2NrIFx1MjAxNCBhbm90aGVyIHJlY29uY2lsaWF0aW9uIG1heSBiZSBpbiBwcm9ncmVzc1wiKTtcbiAgICAgIGNvbnN0IGVudHJpZXMgPSBwZWVrTG9ncygpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGVudHJpZXMubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChlbnRyaWVzWzBdLnNldmVyaXR5LCBcIndhcm5cIik7XG4gICAgICBhc3NlcnQuZXF1YWwoZW50cmllc1swXS5jb21wb25lbnQsIFwicmVjb25jaWxlXCIpO1xuICAgIH0pO1xuXG4gICAgdGVzdChcInN1bW1hcml6ZUxvZ3MgaW5jbHVkZXMgZGIgYW5kIGRpc3BhdGNoIGVudHJpZXNcIiwgKCkgPT4ge1xuICAgICAgbG9nRXJyb3IoXCJkYlwiLCBcIndvcmt0cmVlIERCIHJlY29uY2lsaWF0aW9uIGZhaWxlZDogcGF0aCBjb250YWlucyB1bnNhZmUgY2hhcmFjdGVyc1wiKTtcbiAgICAgIGxvZ1dhcm5pbmcoXCJkaXNwYXRjaFwiLCBcImdyYXBoIGRlcml2YXRpb24gdGltZW91dFwiKTtcbiAgICAgIGNvbnN0IHN1bW1hcnkgPSBzdW1tYXJpemVMb2dzKCkhO1xuICAgICAgYXNzZXJ0Lm9rKHN1bW1hcnkuaW5jbHVkZXMoXCIxIGVycm9yKHMpXCIpKTtcbiAgICAgIGFzc2VydC5vayhzdW1tYXJ5LmluY2x1ZGVzKFwiMSB3YXJuaW5nKHMpXCIpKTtcbiAgICAgIGFzc2VydC5vayhzdW1tYXJ5LmluY2x1ZGVzKFwidW5zYWZlIGNoYXJhY3RlcnNcIikpO1xuICAgICAgYXNzZXJ0Lm9rKHN1bW1hcnkuaW5jbHVkZXMoXCJncmFwaCBkZXJpdmF0aW9uIHRpbWVvdXRcIikpO1xuICAgIH0pO1xuXG4gICAgdGVzdChcImZvcm1hdEZvck5vdGlmaWNhdGlvbiByZW5kZXJzIGRiIGFuZCBkaXNwYXRjaCBjb21wb25lbnRzXCIsICgpID0+IHtcbiAgICAgIGxvZ0Vycm9yKFwiZGJcIiwgXCJjb3B5IGZhaWxlZFwiKTtcbiAgICAgIGxvZ1dhcm5pbmcoXCJkaXNwYXRjaFwiLCBcInNsb3cgZGVyaXZhdGlvblwiKTtcbiAgICAgIGNvbnN0IGVudHJpZXMgPSBkcmFpbkxvZ3MoKTtcbiAgICAgIGNvbnN0IGZvcm1hdHRlZCA9IGZvcm1hdEZvck5vdGlmaWNhdGlvbihlbnRyaWVzKTtcbiAgICAgIGFzc2VydC5vayhmb3JtYXR0ZWQuaW5jbHVkZXMoXCJbZGJdIGNvcHkgZmFpbGVkXCIpKTtcbiAgICAgIGFzc2VydC5vayhmb3JtYXR0ZWQuaW5jbHVkZXMoXCJbZGlzcGF0Y2hdIHNsb3cgZGVyaXZhdGlvblwiKSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKFwic3RkZXJyIG91dHB1dFwiLCAoKSA9PiB7XG4gICAgdGVzdChcImtlZXBzIHdhcm5pbmdzIG91dCBvZiBzdGRlcnIgYnV0IHBlcnNpc3RzIHRoZW0gdG8gbm90aWZpY2F0aW9uc1wiLCAodCkgPT4ge1xuICAgICAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJ3bC1ub3RpZnktXCIpO1xuICAgICAgY29uc3Qgd3JpdHRlbjogc3RyaW5nW10gPSBbXTtcbiAgICAgIGNvbnN0IG9yaWcgPSBwcm9jZXNzLnN0ZGVyci53cml0ZS5iaW5kKHByb2Nlc3Muc3RkZXJyKTtcbiAgICAgIC8vIEB0cy1pZ25vcmUgXHUyMDE0IHBhdGNoaW5nIGZvciB0ZXN0XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZSA9IChjaHVuazogc3RyaW5nKSA9PiB7IHdyaXR0ZW4ucHVzaChjaHVuayk7IHJldHVybiB0cnVlOyB9O1xuICAgICAgdC5hZnRlcigoKSA9PiB7XG4gICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlID0gb3JpZztcbiAgICAgICAgX3Jlc2V0Tm90aWZpY2F0aW9uU3RvcmUoKTtcbiAgICAgICAgY2xlYW51cChkaXIpO1xuICAgICAgfSk7XG5cbiAgICAgIGluaXROb3RpZmljYXRpb25TdG9yZShkaXIpO1xuICAgICAgbG9nV2FybmluZyhcImVuZ2luZVwiLCBcInRlc3Qgd2FyblwiKTtcbiAgICAgIGFzc2VydC5kZWVwRXF1YWwod3JpdHRlbiwgW10pO1xuXG4gICAgICBjb25zdCBub3RpZmljYXRpb25zID0gcmVhZE5vdGlmaWNhdGlvbnMoZGlyKTtcbiAgICAgIGFzc2VydC5lcXVhbChub3RpZmljYXRpb25zLmxlbmd0aCwgMSk7XG4gICAgICBhc3NlcnQuZXF1YWwobm90aWZpY2F0aW9uc1swXS5zZXZlcml0eSwgXCJ3YXJuaW5nXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKG5vdGlmaWNhdGlvbnNbMF0ubWVzc2FnZSwgXCJbZW5naW5lXSB0ZXN0IHdhcm5cIik7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwid3JpdGVzIEVSUk9SIHByZWZpeCB0byBzdGRlcnIgZm9yIGVycm9yc1wiLCAodCkgPT4ge1xuICAgICAgY29uc3Qgd3JpdHRlbjogc3RyaW5nW10gPSBbXTtcbiAgICAgIGNvbnN0IG9yaWcgPSBwcm9jZXNzLnN0ZGVyci53cml0ZS5iaW5kKHByb2Nlc3Muc3RkZXJyKTtcbiAgICAgIC8vIEB0cy1pZ25vcmUgXHUyMDE0IHBhdGNoaW5nIGZvciB0ZXN0XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZSA9IChjaHVuazogc3RyaW5nKSA9PiB7IHdyaXR0ZW4ucHVzaChjaHVuayk7IHJldHVybiB0cnVlOyB9O1xuICAgICAgdC5hZnRlcigoKSA9PiB7IHByb2Nlc3Muc3RkZXJyLndyaXRlID0gb3JpZzsgfSk7XG5cbiAgICAgIGxvZ0Vycm9yKFwiaW50ZXJjZXB0XCIsIFwiYmxvY2tlZFwiKTtcbiAgICAgIGFzc2VydC5vayh3cml0dGVuWzBdLmluY2x1ZGVzKFwiW2dzZDppbnRlcmNlcHRdIEVSUk9SOiBibG9ja2VkXCIpKTtcbiAgICB9KTtcblxuICAgIHRlc3QoXCJpbmNsdWRlcyBzZXJpYWxpemVkIGNvbnRleHQgaW4gc3RkZXJyIG91dHB1dFwiLCAodCkgPT4ge1xuICAgICAgY29uc3Qgd3JpdHRlbjogc3RyaW5nW10gPSBbXTtcbiAgICAgIGNvbnN0IG9yaWcgPSBwcm9jZXNzLnN0ZGVyci53cml0ZS5iaW5kKHByb2Nlc3Muc3RkZXJyKTtcbiAgICAgIC8vIEB0cy1pZ25vcmUgXHUyMDE0IHBhdGNoaW5nIGZvciB0ZXN0XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZSA9IChjaHVuazogc3RyaW5nKSA9PiB7IHdyaXR0ZW4ucHVzaChjaHVuayk7IHJldHVybiB0cnVlOyB9O1xuICAgICAgdC5hZnRlcigoKSA9PiB7IHByb2Nlc3Muc3RkZXJyLndyaXRlID0gb3JpZzsgfSk7XG5cbiAgICAgIGxvZ0Vycm9yKFwidG9vbFwiLCBcImZhaWxlZFwiLCB7IGNtZDogXCJjb21wbGV0ZV90YXNrXCIgfSk7XG4gICAgICBhc3NlcnQub2sod3JpdHRlblswXS5pbmNsdWRlcygnXCJjbWRcIjpcImNvbXBsZXRlX3Rhc2tcIicpKTtcbiAgICB9KTtcblxuICAgIHRlc3QoXCJzdXBwcmVzc2VzIHN0ZGVyciB3aGVuIGRpc2FibGVkXCIsICh0KSA9PiB7XG4gICAgICBjb25zdCB3cml0dGVuOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgY29uc3Qgb3JpZyA9IHByb2Nlc3Muc3RkZXJyLndyaXRlLmJpbmQocHJvY2Vzcy5zdGRlcnIpO1xuICAgICAgY29uc3QgcHJldmlvdXMgPSBzZXRTdGRlcnJMb2dnaW5nRW5hYmxlZChmYWxzZSk7XG4gICAgICAvLyBAdHMtaWdub3JlIFx1MjAxNCBwYXRjaGluZyBmb3IgdGVzdFxuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUgPSAoY2h1bms6IHN0cmluZykgPT4geyB3cml0dGVuLnB1c2goY2h1bmspOyByZXR1cm4gdHJ1ZTsgfTtcbiAgICAgIHQuYWZ0ZXIoKCkgPT4ge1xuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZSA9IG9yaWc7XG4gICAgICAgIHNldFN0ZGVyckxvZ2dpbmdFbmFibGVkKHByZXZpb3VzKTtcbiAgICAgIH0pO1xuXG4gICAgICBsb2dXYXJuaW5nKFwiZW5naW5lXCIsIFwiaGlkZGVuIHdhcm5pbmdcIik7XG4gICAgICBhc3NlcnQuZGVlcEVxdWFsKHdyaXR0ZW4sIFtdKTtcbiAgICB9KTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLFNBQVMsVUFBVSxNQUFNLFlBQVksaUJBQWlCO0FBQ3RELE9BQU8sWUFBWTtBQUNuQixTQUFTLFlBQVksb0JBQW9CO0FBQ3pDLFNBQVMsWUFBWTtBQUNyQixTQUFTLGFBQWEsZUFBZTtBQUNyQztBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1A7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBRVAsTUFBTSxTQUFTO0FBRWYsU0FBUyxtQkFBbUIsTUFBTTtBQUNoQyxhQUFXLE1BQU07QUFDZixlQUFXO0FBQUEsRUFDYixDQUFDO0FBRUQsV0FBUyxnQkFBZ0IsTUFBTTtBQUM3QixTQUFLLCtDQUErQyxNQUFNO0FBQ3hELGlCQUFXLFVBQVUsY0FBYztBQUNuQyxZQUFNLFVBQVUs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
