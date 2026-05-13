import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  realpathSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  initMetrics,
  resetMetrics,
  getLedger,
  snapshotUnitMetrics,
  initMetricsByScope,
  getLedgerByScope,
  resetMetricsByScope,
  snapshotUnitMetricsByScope
} from "../metrics.js";
import { createWorkspace, scopeMilestone } from "../workspace.js";
function makeProjectDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-metrics-scope-")));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  return dir;
}
function mockCtx(messages = []) {
  const entries = messages.map((msg, i) => ({
    type: "message",
    id: `entry-${i}`,
    parentId: i > 0 ? `entry-${i - 1}` : null,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    message: msg
  }));
  return {
    sessionManager: { getEntries: () => entries },
    model: { id: "test-model" }
  };
}
function assistantMsg(input = 1e3, output = 500) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { total: 0.01 }
    }
  };
}
describe("ByScope variant writes to the same path as legacy variant", () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeProjectDir();
    resetMetrics();
  });
  afterEach(() => {
    resetMetrics();
    rmSync(projectDir, { recursive: true, force: true });
  });
  test("metrics.json written by snapshotUnitMetrics matches path used by snapshotUnitMetricsByScope", () => {
    const ws = createWorkspace(projectDir);
    const scope = scopeMilestone(ws, "M001");
    const ctx = mockCtx([assistantMsg()]);
    const startedAt = Date.now() - 5e3;
    initMetrics(projectDir);
    snapshotUnitMetrics(ctx, "execute-task", "M001/S01/T01", startedAt, "test-model");
    resetMetrics();
    initMetricsByScope(scope);
    const scopedLedger = getLedgerByScope(scope);
    assert.ok(scopedLedger, "scoped ledger should load the same metrics.json");
    assert.equal(scopedLedger.units.length, 1, "should see the unit written by legacy path");
    assert.equal(scopedLedger.units[0].id, "M001/S01/T01");
    resetMetricsByScope(scope);
  });
  test("snapshotUnitMetricsByScope writes to the same metrics.json as the legacy path", () => {
    const ws = createWorkspace(projectDir);
    const scope = scopeMilestone(ws, "M001");
    const ctx = mockCtx([assistantMsg()]);
    const startedAt = Date.now() - 5e3;
    snapshotUnitMetricsByScope(scope, ctx, "execute-task", "M001/S01/T01", startedAt, "test-model");
    resetMetricsByScope(scope);
    initMetrics(projectDir);
    const legacyLedger = getLedger();
    assert.ok(legacyLedger, "legacy path should read what the scope variant wrote");
    assert.equal(legacyLedger.units.length, 1);
    assert.equal(legacyLedger.units[0].id, "M001/S01/T01");
    resetMetrics();
  });
});
describe("ByScope variant is pinned to scope \u2014 cwd-drift does not move write target", () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeProjectDir();
    resetMetrics();
  });
  afterEach(() => {
    resetMetrics();
    rmSync(projectDir, { recursive: true, force: true });
  });
  test("write target is the scope's projectRoot regardless of process.cwd()", () => {
    const ws = createWorkspace(projectDir);
    const scope = scopeMilestone(ws, "M001");
    const ctx = mockCtx([assistantMsg()]);
    const startedAt = Date.now() - 3e3;
    const expectedMetricsPath = join(ws.projectRoot, ".gsd", "metrics.json");
    snapshotUnitMetricsByScope(scope, ctx, "execute-task", "M001/S01/T01", startedAt, "test-model");
    const raw = readFileSync(expectedMetricsPath, "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.units.length, 1);
    assert.equal(parsed.units[0].id, "M001/S01/T01");
    resetMetricsByScope(scope);
  });
  test("two scopes for different projectRoots write to separate metrics.json files", () => {
    const projectDir2 = makeProjectDir();
    try {
      const ws1 = createWorkspace(projectDir);
      const ws2 = createWorkspace(projectDir2);
      const scope1 = scopeMilestone(ws1, "M001");
      const scope2 = scopeMilestone(ws2, "M002");
      const ctx = mockCtx([assistantMsg()]);
      const startedAt = Date.now() - 3e3;
      snapshotUnitMetricsByScope(scope1, ctx, "execute-task", "M001/S01/T01", startedAt, "test-model");
      snapshotUnitMetricsByScope(scope2, ctx, "execute-task", "M002/S01/T01", startedAt, "test-model");
      const metrics1 = JSON.parse(
        readFileSync(join(ws1.projectRoot, ".gsd", "metrics.json"), "utf-8")
      );
      const metrics2 = JSON.parse(
        readFileSync(join(ws2.projectRoot, ".gsd", "metrics.json"), "utf-8")
      );
      assert.equal(metrics1.units.length, 1);
      assert.equal(metrics1.units[0].id, "M001/S01/T01");
      assert.equal(metrics2.units.length, 1);
      assert.equal(metrics2.units[0].id, "M002/S01/T01");
      resetMetricsByScope(scope1);
      resetMetricsByScope(scope2);
    } finally {
      rmSync(projectDir2, { recursive: true, force: true });
    }
  });
});
describe("ByScope works without calling initMetrics", () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeProjectDir();
  });
  afterEach(() => {
    resetMetrics();
    rmSync(projectDir, { recursive: true, force: true });
  });
  test("snapshotUnitMetricsByScope succeeds without initMetrics having been called", () => {
    const ws = createWorkspace(projectDir);
    const scope = scopeMilestone(ws, "M001");
    const ctx = mockCtx([assistantMsg()]);
    assert.equal(getLedger(), null, "module singleton should be null \u2014 initMetrics was never called");
    const unit = snapshotUnitMetricsByScope(
      scope,
      ctx,
      "execute-task",
      "M001/S01/T01",
      Date.now() - 2e3,
      "test-model"
    );
    assert.ok(unit, "snapshotUnitMetricsByScope should return a unit");
    assert.equal(unit.id, "M001/S01/T01");
    const raw = readFileSync(join(projectDir, ".gsd", "metrics.json"), "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.units.length, 1);
    resetMetricsByScope(scope);
  });
  test("initMetricsByScope succeeds without initMetrics having been called", () => {
    const ws = createWorkspace(projectDir);
    const scope = scopeMilestone(ws, "M001");
    assert.equal(getLedger(), null);
    initMetricsByScope(scope);
    const l = getLedgerByScope(scope);
    assert.ok(l, "getLedgerByScope should return a ledger after initMetricsByScope");
    assert.equal(l.version, 1);
    assert.equal(l.units.length, 0);
    resetMetricsByScope(scope);
  });
});
describe("ByScope atomic write-merge \u2014 concurrent writers do not clobber", () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeProjectDir();
    resetMetrics();
  });
  afterEach(() => {
    resetMetrics();
    rmSync(projectDir, { recursive: true, force: true });
  });
  const MERGE_WORKER = `
const { openSync, closeSync, unlinkSync, existsSync, readFileSync, mkdirSync, renameSync } = require('node:fs');
const { dirname } = require('node:path');
const { randomBytes } = require('node:crypto');

const metricsPath = process.env.GSD_SCOPE_METRICS_PATH;
const milestoneId = process.env.GSD_SCOPE_MILESTONE_ID;
const lockPath = metricsPath + '.lock';

function acquireLock(lp, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const fd = openSync(lp, 'wx'); closeSync(fd); return true; }
    catch { const w = Date.now() + Math.min(50, deadline - Date.now()); while (Date.now() < w) {} }
  }
  return false;
}
function releaseLock(lp) { try { unlinkSync(lp); } catch {} }
function saveAtomic(fp, data) {
  mkdirSync(dirname(fp), { recursive: true });
  const tmp = fp + '.tmp.' + randomBytes(4).toString('hex');
  require('node:fs').writeFileSync(tmp, JSON.stringify(data, null, 2) + '\\n', 'utf-8');
  renameSync(tmp, fp);
}
function dedup(units) {
  const m = new Map();
  for (const u of units) {
    const k = u.type + '\\0' + u.id + '\\0' + u.startedAt;
    const e = m.get(k);
    if (!e || u.finishedAt > e.finishedAt) m.set(k, u);
  }
  return Array.from(m.values());
}

const unit = {
  type: 'execute-task', id: milestoneId + '/S01/T01', model: 'test',
  startedAt: 1000, finishedAt: Date.now(),
  tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
  cost: 0.001, toolCalls: 0, assistantMessages: 1, userMessages: 1,
};
const workerLedger = { version: 1, projectStartedAt: 1000, units: [unit] };

const acquired = acquireLock(lockPath, 5000);
try {
  let diskUnits = [];
  if (existsSync(metricsPath)) {
    try { const p = JSON.parse(readFileSync(metricsPath, 'utf-8')); if (p && Array.isArray(p.units)) diskUnits = p.units; } catch {}
  }
  saveAtomic(metricsPath, { ...workerLedger, units: dedup([...diskUnits, ...workerLedger.units]) });
} finally {
  if (acquired) releaseLock(lockPath);
}
`;
  function spawnMergeWorker(metricsPath, milestoneId) {
    const result = spawnSync(process.execPath, ["-e", MERGE_WORKER], {
      env: {
        ...process.env,
        GSD_SCOPE_METRICS_PATH: metricsPath,
        GSD_SCOPE_MILESTONE_ID: milestoneId
      },
      encoding: "utf-8",
      timeout: 1e4
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Worker for ${milestoneId} failed:
${result.stderr}`);
    }
  }
  test("snapshotUnitMetricsByScope preserves a pre-existing entry written by a concurrent worker", () => {
    const ws = createWorkspace(projectDir);
    const scope = scopeMilestone(ws, "M002");
    const metricsPath = join(ws.projectRoot, ".gsd", "metrics.json");
    spawnMergeWorker(metricsPath, "M001");
    const ctx = mockCtx([assistantMsg()]);
    snapshotUnitMetricsByScope(
      scope,
      ctx,
      "execute-task",
      "M002/S01/T01",
      Date.now() - 2e3,
      "test-model"
    );
    const raw = readFileSync(metricsPath, "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.units.length, 2, "both M001 and M002 units must be in metrics.json");
    const ids = parsed.units.map((u) => u.id);
    assert.ok(ids.some((id) => id.startsWith("M001")), "M001 unit must be preserved");
    assert.ok(ids.some((id) => id.startsWith("M002")), "M002 unit must be present");
    resetMetricsByScope(scope);
  });
  test("idempotent ByScope snapshot does not duplicate units on disk", () => {
    const ws = createWorkspace(projectDir);
    const scope = scopeMilestone(ws, "M001");
    const ctx = mockCtx([assistantMsg()]);
    const startedAt = Date.now() - 3e3;
    const metricsPath = join(ws.projectRoot, ".gsd", "metrics.json");
    snapshotUnitMetricsByScope(scope, ctx, "execute-task", "M001/S01/T01", startedAt, "test-model");
    snapshotUnitMetricsByScope(scope, ctx, "execute-task", "M001/S01/T01", startedAt, "test-model");
    const parsed = JSON.parse(readFileSync(metricsPath, "utf-8"));
    assert.equal(parsed.units.length, 1, "duplicate snapshots must not create duplicate entries");
    resetMetricsByScope(scope);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9tZXRyaWNzLXNjb3BlLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRC0yICsgbWV0cmljcy1zY29wZS50ZXN0LnRzOiB0ZXN0cyBmb3Igc2NvcGUtYXdhcmUgbWV0cmljcyB2YXJpYW50cyAoQzYpXG5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0LCBiZWZvcmVFYWNoLCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7XG4gIG1rZHRlbXBTeW5jLFxuICBta2RpclN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgcm1TeW5jLFxuICByZWFscGF0aFN5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IHNwYXduU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcblxuaW1wb3J0IHtcbiAgaW5pdE1ldHJpY3MsXG4gIHJlc2V0TWV0cmljcyxcbiAgZ2V0TGVkZ2VyLFxuICBzbmFwc2hvdFVuaXRNZXRyaWNzLFxuICBpbml0TWV0cmljc0J5U2NvcGUsXG4gIGdldExlZGdlckJ5U2NvcGUsXG4gIHJlc2V0TWV0cmljc0J5U2NvcGUsXG4gIHNuYXBzaG90VW5pdE1ldHJpY3NCeVNjb3BlLFxuICB0eXBlIE1ldHJpY3NMZWRnZXIsXG4gIHR5cGUgVW5pdE1ldHJpY3MsXG59IGZyb20gXCIuLi9tZXRyaWNzLmpzXCI7XG5pbXBvcnQgeyBjcmVhdGVXb3Jrc3BhY2UsIHNjb3BlTWlsZXN0b25lIH0gZnJvbSBcIi4uL3dvcmtzcGFjZS5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gbWFrZVByb2plY3REaXIoKTogc3RyaW5nIHtcbiAgY29uc3QgZGlyID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLW1ldHJpY3Mtc2NvcGUtXCIpKSk7XG4gIG1rZGlyU3luYyhqb2luKGRpciwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGRpcjtcbn1cblxuZnVuY3Rpb24gbW9ja0N0eChtZXNzYWdlczogYW55W10gPSBbXSk6IGFueSB7XG4gIGNvbnN0IGVudHJpZXMgPSBtZXNzYWdlcy5tYXAoKG1zZywgaSkgPT4gKHtcbiAgICB0eXBlOiBcIm1lc3NhZ2VcIixcbiAgICBpZDogYGVudHJ5LSR7aX1gLFxuICAgIHBhcmVudElkOiBpID4gMCA/IGBlbnRyeS0ke2kgLSAxfWAgOiBudWxsLFxuICAgIHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIG1lc3NhZ2U6IG1zZyxcbiAgfSkpO1xuICByZXR1cm4ge1xuICAgIHNlc3Npb25NYW5hZ2VyOiB7IGdldEVudHJpZXM6ICgpID0+IGVudHJpZXMgfSxcbiAgICBtb2RlbDogeyBpZDogXCJ0ZXN0LW1vZGVsXCIgfSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gYXNzaXN0YW50TXNnKGlucHV0ID0gMTAwMCwgb3V0cHV0ID0gNTAwKTogYW55IHtcbiAgcmV0dXJuIHtcbiAgICByb2xlOiBcImFzc2lzdGFudFwiLFxuICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcImRvbmVcIiB9XSxcbiAgICB1c2FnZToge1xuICAgICAgaW5wdXQsXG4gICAgICBvdXRwdXQsXG4gICAgICBjYWNoZVJlYWQ6IDAsXG4gICAgICBjYWNoZVdyaXRlOiAwLFxuICAgICAgdG90YWxUb2tlbnM6IGlucHV0ICsgb3V0cHV0LFxuICAgICAgY29zdDogeyB0b3RhbDogMC4wMSB9LFxuICAgIH0sXG4gIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJCeVNjb3BlIHZhcmlhbnQgd3JpdGVzIHRvIHRoZSBzYW1lIHBhdGggYXMgbGVnYWN5IHZhcmlhbnRcIiwgKCkgPT4ge1xuICBsZXQgcHJvamVjdERpcjogc3RyaW5nO1xuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIHByb2plY3REaXIgPSBtYWtlUHJvamVjdERpcigpO1xuICAgIHJlc2V0TWV0cmljcygpO1xuICB9KTtcblxuICBhZnRlckVhY2goKCkgPT4ge1xuICAgIHJlc2V0TWV0cmljcygpO1xuICAgIHJtU3luYyhwcm9qZWN0RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJtZXRyaWNzLmpzb24gd3JpdHRlbiBieSBzbmFwc2hvdFVuaXRNZXRyaWNzIG1hdGNoZXMgcGF0aCB1c2VkIGJ5IHNuYXBzaG90VW5pdE1ldHJpY3NCeVNjb3BlXCIsICgpID0+IHtcbiAgICBjb25zdCB3cyA9IGNyZWF0ZVdvcmtzcGFjZShwcm9qZWN0RGlyKTtcbiAgICBjb25zdCBzY29wZSA9IHNjb3BlTWlsZXN0b25lKHdzLCBcIk0wMDFcIik7XG5cbiAgICBjb25zdCBjdHggPSBtb2NrQ3R4KFthc3Npc3RhbnRNc2coKV0pO1xuICAgIGNvbnN0IHN0YXJ0ZWRBdCA9IERhdGUubm93KCkgLSA1MDAwO1xuXG4gICAgLy8gV3JpdGUgdmlhIGxlZ2FjeSBwYXRoXG4gICAgaW5pdE1ldHJpY3MocHJvamVjdERpcik7XG4gICAgc25hcHNob3RVbml0TWV0cmljcyhjdHgsIFwiZXhlY3V0ZS10YXNrXCIsIFwiTTAwMS9TMDEvVDAxXCIsIHN0YXJ0ZWRBdCwgXCJ0ZXN0LW1vZGVsXCIpO1xuICAgIHJlc2V0TWV0cmljcygpO1xuXG4gICAgLy8gUmVhZCB2aWEgc2NvcGUgcGF0aFxuICAgIGluaXRNZXRyaWNzQnlTY29wZShzY29wZSk7XG4gICAgY29uc3Qgc2NvcGVkTGVkZ2VyID0gZ2V0TGVkZ2VyQnlTY29wZShzY29wZSk7XG4gICAgYXNzZXJ0Lm9rKHNjb3BlZExlZGdlciwgXCJzY29wZWQgbGVkZ2VyIHNob3VsZCBsb2FkIHRoZSBzYW1lIG1ldHJpY3MuanNvblwiKTtcbiAgICBhc3NlcnQuZXF1YWwoc2NvcGVkTGVkZ2VyIS51bml0cy5sZW5ndGgsIDEsIFwic2hvdWxkIHNlZSB0aGUgdW5pdCB3cml0dGVuIGJ5IGxlZ2FjeSBwYXRoXCIpO1xuICAgIGFzc2VydC5lcXVhbChzY29wZWRMZWRnZXIhLnVuaXRzWzBdLmlkLCBcIk0wMDEvUzAxL1QwMVwiKTtcbiAgICByZXNldE1ldHJpY3NCeVNjb3BlKHNjb3BlKTtcbiAgfSk7XG5cbiAgdGVzdChcInNuYXBzaG90VW5pdE1ldHJpY3NCeVNjb3BlIHdyaXRlcyB0byB0aGUgc2FtZSBtZXRyaWNzLmpzb24gYXMgdGhlIGxlZ2FjeSBwYXRoXCIsICgpID0+IHtcbiAgICBjb25zdCB3cyA9IGNyZWF0ZVdvcmtzcGFjZShwcm9qZWN0RGlyKTtcbiAgICBjb25zdCBzY29wZSA9IHNjb3BlTWlsZXN0b25lKHdzLCBcIk0wMDFcIik7XG4gICAgY29uc3QgY3R4ID0gbW9ja0N0eChbYXNzaXN0YW50TXNnKCldKTtcbiAgICBjb25zdCBzdGFydGVkQXQgPSBEYXRlLm5vdygpIC0gNTAwMDtcblxuICAgIC8vIFdyaXRlIHZpYSBzY29wZSBwYXRoIChubyBpbml0TWV0cmljcyBjYWxsZWQpXG4gICAgc25hcHNob3RVbml0TWV0cmljc0J5U2NvcGUoc2NvcGUsIGN0eCwgXCJleGVjdXRlLXRhc2tcIiwgXCJNMDAxL1MwMS9UMDFcIiwgc3RhcnRlZEF0LCBcInRlc3QtbW9kZWxcIik7XG4gICAgcmVzZXRNZXRyaWNzQnlTY29wZShzY29wZSk7XG5cbiAgICAvLyBSZWFkIHZpYSBsZWdhY3kgcGF0aFxuICAgIGluaXRNZXRyaWNzKHByb2plY3REaXIpO1xuICAgIGNvbnN0IGxlZ2FjeUxlZGdlciA9IGdldExlZGdlcigpO1xuICAgIGFzc2VydC5vayhsZWdhY3lMZWRnZXIsIFwibGVnYWN5IHBhdGggc2hvdWxkIHJlYWQgd2hhdCB0aGUgc2NvcGUgdmFyaWFudCB3cm90ZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwobGVnYWN5TGVkZ2VyIS51bml0cy5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5lcXVhbChsZWdhY3lMZWRnZXIhLnVuaXRzWzBdLmlkLCBcIk0wMDEvUzAxL1QwMVwiKTtcbiAgICByZXNldE1ldHJpY3MoKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJCeVNjb3BlIHZhcmlhbnQgaXMgcGlubmVkIHRvIHNjb3BlIFx1MjAxNCBjd2QtZHJpZnQgZG9lcyBub3QgbW92ZSB3cml0ZSB0YXJnZXRcIiwgKCkgPT4ge1xuICBsZXQgcHJvamVjdERpcjogc3RyaW5nO1xuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIHByb2plY3REaXIgPSBtYWtlUHJvamVjdERpcigpO1xuICAgIHJlc2V0TWV0cmljcygpO1xuICB9KTtcblxuICBhZnRlckVhY2goKCkgPT4ge1xuICAgIHJlc2V0TWV0cmljcygpO1xuICAgIHJtU3luYyhwcm9qZWN0RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJ3cml0ZSB0YXJnZXQgaXMgdGhlIHNjb3BlJ3MgcHJvamVjdFJvb3QgcmVnYXJkbGVzcyBvZiBwcm9jZXNzLmN3ZCgpXCIsICgpID0+IHtcbiAgICBjb25zdCB3cyA9IGNyZWF0ZVdvcmtzcGFjZShwcm9qZWN0RGlyKTtcbiAgICBjb25zdCBzY29wZSA9IHNjb3BlTWlsZXN0b25lKHdzLCBcIk0wMDFcIik7XG4gICAgY29uc3QgY3R4ID0gbW9ja0N0eChbYXNzaXN0YW50TXNnKCldKTtcbiAgICBjb25zdCBzdGFydGVkQXQgPSBEYXRlLm5vdygpIC0gMzAwMDtcblxuICAgIC8vIFJlY29yZCBwcm9qZWN0Um9vdCBiZWZvcmUgd3JpdGluZ1xuICAgIGNvbnN0IGV4cGVjdGVkTWV0cmljc1BhdGggPSBqb2luKHdzLnByb2plY3RSb290LCBcIi5nc2RcIiwgXCJtZXRyaWNzLmpzb25cIik7XG5cbiAgICBzbmFwc2hvdFVuaXRNZXRyaWNzQnlTY29wZShzY29wZSwgY3R4LCBcImV4ZWN1dGUtdGFza1wiLCBcIk0wMDEvUzAxL1QwMVwiLCBzdGFydGVkQXQsIFwidGVzdC1tb2RlbFwiKTtcblxuICAgIC8vIFZlcmlmeSB0aGUgZmlsZSB3YXMgd3JpdHRlbiB0byB0aGUgZXhwZWN0ZWQgbG9jYXRpb25cbiAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoZXhwZWN0ZWRNZXRyaWNzUGF0aCwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBwYXJzZWQ6IE1ldHJpY3NMZWRnZXIgPSBKU09OLnBhcnNlKHJhdyk7XG4gICAgYXNzZXJ0LmVxdWFsKHBhcnNlZC51bml0cy5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5lcXVhbChwYXJzZWQudW5pdHNbMF0uaWQsIFwiTTAwMS9TMDEvVDAxXCIpO1xuXG4gICAgcmVzZXRNZXRyaWNzQnlTY29wZShzY29wZSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJ0d28gc2NvcGVzIGZvciBkaWZmZXJlbnQgcHJvamVjdFJvb3RzIHdyaXRlIHRvIHNlcGFyYXRlIG1ldHJpY3MuanNvbiBmaWxlc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcHJvamVjdERpcjIgPSBtYWtlUHJvamVjdERpcigpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB3czEgPSBjcmVhdGVXb3Jrc3BhY2UocHJvamVjdERpcik7XG4gICAgICBjb25zdCB3czIgPSBjcmVhdGVXb3Jrc3BhY2UocHJvamVjdERpcjIpO1xuICAgICAgY29uc3Qgc2NvcGUxID0gc2NvcGVNaWxlc3RvbmUod3MxLCBcIk0wMDFcIik7XG4gICAgICBjb25zdCBzY29wZTIgPSBzY29wZU1pbGVzdG9uZSh3czIsIFwiTTAwMlwiKTtcblxuICAgICAgY29uc3QgY3R4ID0gbW9ja0N0eChbYXNzaXN0YW50TXNnKCldKTtcbiAgICAgIGNvbnN0IHN0YXJ0ZWRBdCA9IERhdGUubm93KCkgLSAzMDAwO1xuXG4gICAgICBzbmFwc2hvdFVuaXRNZXRyaWNzQnlTY29wZShzY29wZTEsIGN0eCwgXCJleGVjdXRlLXRhc2tcIiwgXCJNMDAxL1MwMS9UMDFcIiwgc3RhcnRlZEF0LCBcInRlc3QtbW9kZWxcIik7XG4gICAgICBzbmFwc2hvdFVuaXRNZXRyaWNzQnlTY29wZShzY29wZTIsIGN0eCwgXCJleGVjdXRlLXRhc2tcIiwgXCJNMDAyL1MwMS9UMDFcIiwgc3RhcnRlZEF0LCBcInRlc3QtbW9kZWxcIik7XG5cbiAgICAgIGNvbnN0IG1ldHJpY3MxID0gSlNPTi5wYXJzZShcbiAgICAgICAgcmVhZEZpbGVTeW5jKGpvaW4od3MxLnByb2plY3RSb290LCBcIi5nc2RcIiwgXCJtZXRyaWNzLmpzb25cIiksIFwidXRmLThcIiksXG4gICAgICApIGFzIE1ldHJpY3NMZWRnZXI7XG4gICAgICBjb25zdCBtZXRyaWNzMiA9IEpTT04ucGFyc2UoXG4gICAgICAgIHJlYWRGaWxlU3luYyhqb2luKHdzMi5wcm9qZWN0Um9vdCwgXCIuZ3NkXCIsIFwibWV0cmljcy5qc29uXCIpLCBcInV0Zi04XCIpLFxuICAgICAgKSBhcyBNZXRyaWNzTGVkZ2VyO1xuXG4gICAgICBhc3NlcnQuZXF1YWwobWV0cmljczEudW5pdHMubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChtZXRyaWNzMS51bml0c1swXS5pZCwgXCJNMDAxL1MwMS9UMDFcIik7XG4gICAgICBhc3NlcnQuZXF1YWwobWV0cmljczIudW5pdHMubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChtZXRyaWNzMi51bml0c1swXS5pZCwgXCJNMDAyL1MwMS9UMDFcIik7XG5cbiAgICAgIHJlc2V0TWV0cmljc0J5U2NvcGUoc2NvcGUxKTtcbiAgICAgIHJlc2V0TWV0cmljc0J5U2NvcGUoc2NvcGUyKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHByb2plY3REaXIyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcIkJ5U2NvcGUgd29ya3Mgd2l0aG91dCBjYWxsaW5nIGluaXRNZXRyaWNzXCIsICgpID0+IHtcbiAgbGV0IHByb2plY3REaXI6IHN0cmluZztcblxuICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICBwcm9qZWN0RGlyID0gbWFrZVByb2plY3REaXIoKTtcbiAgICAvLyBEZWxpYmVyYXRlbHkgZG8gTk9UIGNhbGwgaW5pdE1ldHJpY3MgLyByZXNldE1ldHJpY3NcbiAgfSk7XG5cbiAgYWZ0ZXJFYWNoKCgpID0+IHtcbiAgICByZXNldE1ldHJpY3MoKTtcbiAgICBybVN5bmMocHJvamVjdERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICB0ZXN0KFwic25hcHNob3RVbml0TWV0cmljc0J5U2NvcGUgc3VjY2VlZHMgd2l0aG91dCBpbml0TWV0cmljcyBoYXZpbmcgYmVlbiBjYWxsZWRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHdzID0gY3JlYXRlV29ya3NwYWNlKHByb2plY3REaXIpO1xuICAgIGNvbnN0IHNjb3BlID0gc2NvcGVNaWxlc3RvbmUod3MsIFwiTTAwMVwiKTtcbiAgICBjb25zdCBjdHggPSBtb2NrQ3R4KFthc3Npc3RhbnRNc2coKV0pO1xuXG4gICAgLy8gQ29uZmlybSBzaW5nbGV0b24gd2FzIG5ldmVyIGluaXRpYWxpemVkXG4gICAgYXNzZXJ0LmVxdWFsKGdldExlZGdlcigpLCBudWxsLCBcIm1vZHVsZSBzaW5nbGV0b24gc2hvdWxkIGJlIG51bGwgXHUyMDE0IGluaXRNZXRyaWNzIHdhcyBuZXZlciBjYWxsZWRcIik7XG5cbiAgICBjb25zdCB1bml0ID0gc25hcHNob3RVbml0TWV0cmljc0J5U2NvcGUoXG4gICAgICBzY29wZSxcbiAgICAgIGN0eCxcbiAgICAgIFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgICBcIk0wMDEvUzAxL1QwMVwiLFxuICAgICAgRGF0ZS5ub3coKSAtIDIwMDAsXG4gICAgICBcInRlc3QtbW9kZWxcIixcbiAgICApO1xuICAgIGFzc2VydC5vayh1bml0LCBcInNuYXBzaG90VW5pdE1ldHJpY3NCeVNjb3BlIHNob3VsZCByZXR1cm4gYSB1bml0XCIpO1xuICAgIGFzc2VydC5lcXVhbCh1bml0IS5pZCwgXCJNMDAxL1MwMS9UMDFcIik7XG5cbiAgICAvLyBWZXJpZnkgb24gZGlza1xuICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhqb2luKHByb2plY3REaXIsIFwiLmdzZFwiLCBcIm1ldHJpY3MuanNvblwiKSwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBwYXJzZWQ6IE1ldHJpY3NMZWRnZXIgPSBKU09OLnBhcnNlKHJhdyk7XG4gICAgYXNzZXJ0LmVxdWFsKHBhcnNlZC51bml0cy5sZW5ndGgsIDEpO1xuXG4gICAgcmVzZXRNZXRyaWNzQnlTY29wZShzY29wZSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJpbml0TWV0cmljc0J5U2NvcGUgc3VjY2VlZHMgd2l0aG91dCBpbml0TWV0cmljcyBoYXZpbmcgYmVlbiBjYWxsZWRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHdzID0gY3JlYXRlV29ya3NwYWNlKHByb2plY3REaXIpO1xuICAgIGNvbnN0IHNjb3BlID0gc2NvcGVNaWxlc3RvbmUod3MsIFwiTTAwMVwiKTtcblxuICAgIGFzc2VydC5lcXVhbChnZXRMZWRnZXIoKSwgbnVsbCk7XG5cbiAgICBpbml0TWV0cmljc0J5U2NvcGUoc2NvcGUpO1xuICAgIGNvbnN0IGwgPSBnZXRMZWRnZXJCeVNjb3BlKHNjb3BlKTtcbiAgICBhc3NlcnQub2sobCwgXCJnZXRMZWRnZXJCeVNjb3BlIHNob3VsZCByZXR1cm4gYSBsZWRnZXIgYWZ0ZXIgaW5pdE1ldHJpY3NCeVNjb3BlXCIpO1xuICAgIGFzc2VydC5lcXVhbChsIS52ZXJzaW9uLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwobCEudW5pdHMubGVuZ3RoLCAwKTtcblxuICAgIHJlc2V0TWV0cmljc0J5U2NvcGUoc2NvcGUpO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcIkJ5U2NvcGUgYXRvbWljIHdyaXRlLW1lcmdlIFx1MjAxNCBjb25jdXJyZW50IHdyaXRlcnMgZG8gbm90IGNsb2JiZXJcIiwgKCkgPT4ge1xuICBsZXQgcHJvamVjdERpcjogc3RyaW5nO1xuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIHByb2plY3REaXIgPSBtYWtlUHJvamVjdERpcigpO1xuICAgIHJlc2V0TWV0cmljcygpO1xuICB9KTtcblxuICBhZnRlckVhY2goKCkgPT4ge1xuICAgIHJlc2V0TWV0cmljcygpO1xuICAgIHJtU3luYyhwcm9qZWN0RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIC8vIFdvcmtlciBzY3JpcHQ6IHNhbWUgbG9jayttZXJnZSBzZW1hbnRpY3MgYXMgc2F2ZUxlZGdlciwgd3JpdHRlbiBpbiBwbGFpbiBDSlNcbiAgLy8gc28gaXQgY2FuIHJ1biBhcyBhIGNoaWxkIHByb2Nlc3Mgd2l0aG91dCBsb2FkaW5nIHRoZSBmdWxsIGV4dGVuc2lvbiB0cmVlLlxuICBjb25zdCBNRVJHRV9XT1JLRVIgPSBgXG5jb25zdCB7IG9wZW5TeW5jLCBjbG9zZVN5bmMsIHVubGlua1N5bmMsIGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYywgbWtkaXJTeW5jLCByZW5hbWVTeW5jIH0gPSByZXF1aXJlKCdub2RlOmZzJyk7XG5jb25zdCB7IGRpcm5hbWUgfSA9IHJlcXVpcmUoJ25vZGU6cGF0aCcpO1xuY29uc3QgeyByYW5kb21CeXRlcyB9ID0gcmVxdWlyZSgnbm9kZTpjcnlwdG8nKTtcblxuY29uc3QgbWV0cmljc1BhdGggPSBwcm9jZXNzLmVudi5HU0RfU0NPUEVfTUVUUklDU19QQVRIO1xuY29uc3QgbWlsZXN0b25lSWQgPSBwcm9jZXNzLmVudi5HU0RfU0NPUEVfTUlMRVNUT05FX0lEO1xuY29uc3QgbG9ja1BhdGggPSBtZXRyaWNzUGF0aCArICcubG9jayc7XG5cbmZ1bmN0aW9uIGFjcXVpcmVMb2NrKGxwLCBtcykge1xuICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyBtcztcbiAgd2hpbGUgKERhdGUubm93KCkgPCBkZWFkbGluZSkge1xuICAgIHRyeSB7IGNvbnN0IGZkID0gb3BlblN5bmMobHAsICd3eCcpOyBjbG9zZVN5bmMoZmQpOyByZXR1cm4gdHJ1ZTsgfVxuICAgIGNhdGNoIHsgY29uc3QgdyA9IERhdGUubm93KCkgKyBNYXRoLm1pbig1MCwgZGVhZGxpbmUgLSBEYXRlLm5vdygpKTsgd2hpbGUgKERhdGUubm93KCkgPCB3KSB7fSB9XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuZnVuY3Rpb24gcmVsZWFzZUxvY2sobHApIHsgdHJ5IHsgdW5saW5rU3luYyhscCk7IH0gY2F0Y2gge30gfVxuZnVuY3Rpb24gc2F2ZUF0b21pYyhmcCwgZGF0YSkge1xuICBta2RpclN5bmMoZGlybmFtZShmcCksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBjb25zdCB0bXAgPSBmcCArICcudG1wLicgKyByYW5kb21CeXRlcyg0KS50b1N0cmluZygnaGV4Jyk7XG4gIHJlcXVpcmUoJ25vZGU6ZnMnKS53cml0ZUZpbGVTeW5jKHRtcCwgSlNPTi5zdHJpbmdpZnkoZGF0YSwgbnVsbCwgMikgKyAnXFxcXG4nLCAndXRmLTgnKTtcbiAgcmVuYW1lU3luYyh0bXAsIGZwKTtcbn1cbmZ1bmN0aW9uIGRlZHVwKHVuaXRzKSB7XG4gIGNvbnN0IG0gPSBuZXcgTWFwKCk7XG4gIGZvciAoY29uc3QgdSBvZiB1bml0cykge1xuICAgIGNvbnN0IGsgPSB1LnR5cGUgKyAnXFxcXDAnICsgdS5pZCArICdcXFxcMCcgKyB1LnN0YXJ0ZWRBdDtcbiAgICBjb25zdCBlID0gbS5nZXQoayk7XG4gICAgaWYgKCFlIHx8IHUuZmluaXNoZWRBdCA+IGUuZmluaXNoZWRBdCkgbS5zZXQoaywgdSk7XG4gIH1cbiAgcmV0dXJuIEFycmF5LmZyb20obS52YWx1ZXMoKSk7XG59XG5cbmNvbnN0IHVuaXQgPSB7XG4gIHR5cGU6ICdleGVjdXRlLXRhc2snLCBpZDogbWlsZXN0b25lSWQgKyAnL1MwMS9UMDEnLCBtb2RlbDogJ3Rlc3QnLFxuICBzdGFydGVkQXQ6IDEwMDAsIGZpbmlzaGVkQXQ6IERhdGUubm93KCksXG4gIHRva2VuczogeyBpbnB1dDogMTAsIG91dHB1dDogNSwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCB0b3RhbDogMTUgfSxcbiAgY29zdDogMC4wMDEsIHRvb2xDYWxsczogMCwgYXNzaXN0YW50TWVzc2FnZXM6IDEsIHVzZXJNZXNzYWdlczogMSxcbn07XG5jb25zdCB3b3JrZXJMZWRnZXIgPSB7IHZlcnNpb246IDEsIHByb2plY3RTdGFydGVkQXQ6IDEwMDAsIHVuaXRzOiBbdW5pdF0gfTtcblxuY29uc3QgYWNxdWlyZWQgPSBhY3F1aXJlTG9jayhsb2NrUGF0aCwgNTAwMCk7XG50cnkge1xuICBsZXQgZGlza1VuaXRzID0gW107XG4gIGlmIChleGlzdHNTeW5jKG1ldHJpY3NQYXRoKSkge1xuICAgIHRyeSB7IGNvbnN0IHAgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhtZXRyaWNzUGF0aCwgJ3V0Zi04JykpOyBpZiAocCAmJiBBcnJheS5pc0FycmF5KHAudW5pdHMpKSBkaXNrVW5pdHMgPSBwLnVuaXRzOyB9IGNhdGNoIHt9XG4gIH1cbiAgc2F2ZUF0b21pYyhtZXRyaWNzUGF0aCwgeyAuLi53b3JrZXJMZWRnZXIsIHVuaXRzOiBkZWR1cChbLi4uZGlza1VuaXRzLCAuLi53b3JrZXJMZWRnZXIudW5pdHNdKSB9KTtcbn0gZmluYWxseSB7XG4gIGlmIChhY3F1aXJlZCkgcmVsZWFzZUxvY2sobG9ja1BhdGgpO1xufVxuYDtcblxuICBmdW5jdGlvbiBzcGF3bk1lcmdlV29ya2VyKG1ldHJpY3NQYXRoOiBzdHJpbmcsIG1pbGVzdG9uZUlkOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCByZXN1bHQgPSBzcGF3blN5bmMocHJvY2Vzcy5leGVjUGF0aCwgW1wiLWVcIiwgTUVSR0VfV09SS0VSXSwge1xuICAgICAgZW52OiB7XG4gICAgICAgIC4uLnByb2Nlc3MuZW52LFxuICAgICAgICBHU0RfU0NPUEVfTUVUUklDU19QQVRIOiBtZXRyaWNzUGF0aCxcbiAgICAgICAgR1NEX1NDT1BFX01JTEVTVE9ORV9JRDogbWlsZXN0b25lSWQsXG4gICAgICB9LFxuICAgICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgICAgIHRpbWVvdXQ6IDEwXzAwMCxcbiAgICB9KTtcbiAgICBpZiAocmVzdWx0LmVycm9yKSB0aHJvdyByZXN1bHQuZXJyb3I7XG4gICAgaWYgKHJlc3VsdC5zdGF0dXMgIT09IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgV29ya2VyIGZvciAke21pbGVzdG9uZUlkfSBmYWlsZWQ6XFxuJHtyZXN1bHQuc3RkZXJyfWApO1xuICAgIH1cbiAgfVxuXG4gIHRlc3QoXCJzbmFwc2hvdFVuaXRNZXRyaWNzQnlTY29wZSBwcmVzZXJ2ZXMgYSBwcmUtZXhpc3RpbmcgZW50cnkgd3JpdHRlbiBieSBhIGNvbmN1cnJlbnQgd29ya2VyXCIsICgpID0+IHtcbiAgICBjb25zdCB3cyA9IGNyZWF0ZVdvcmtzcGFjZShwcm9qZWN0RGlyKTtcbiAgICBjb25zdCBzY29wZSA9IHNjb3BlTWlsZXN0b25lKHdzLCBcIk0wMDJcIik7XG4gICAgY29uc3QgbWV0cmljc1BhdGggPSBqb2luKHdzLnByb2plY3RSb290LCBcIi5nc2RcIiwgXCJtZXRyaWNzLmpzb25cIik7XG5cbiAgICAvLyBTaW11bGF0ZSBhIGNvbmN1cnJlbnQgd29ya2VyIHRoYXQgYWxyZWFkeSB3cm90ZSBNMDAxJ3MgZW50cnkgdG8gZGlza1xuICAgIHNwYXduTWVyZ2VXb3JrZXIobWV0cmljc1BhdGgsIFwiTTAwMVwiKTtcblxuICAgIC8vIE5vdyB3cml0ZSBNMDAyIHZpYSBzY29wZSB2YXJpYW50IFx1MjAxNCBtdXN0IHByZXNlcnZlIE0wMDEncyBlbnRyeVxuICAgIGNvbnN0IGN0eCA9IG1vY2tDdHgoW2Fzc2lzdGFudE1zZygpXSk7XG4gICAgc25hcHNob3RVbml0TWV0cmljc0J5U2NvcGUoXG4gICAgICBzY29wZSxcbiAgICAgIGN0eCxcbiAgICAgIFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgICBcIk0wMDIvUzAxL1QwMVwiLFxuICAgICAgRGF0ZS5ub3coKSAtIDIwMDAsXG4gICAgICBcInRlc3QtbW9kZWxcIixcbiAgICApO1xuXG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKG1ldHJpY3NQYXRoLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHBhcnNlZDogTWV0cmljc0xlZGdlciA9IEpTT04ucGFyc2UocmF3KTtcbiAgICBhc3NlcnQuZXF1YWwocGFyc2VkLnVuaXRzLmxlbmd0aCwgMiwgXCJib3RoIE0wMDEgYW5kIE0wMDIgdW5pdHMgbXVzdCBiZSBpbiBtZXRyaWNzLmpzb25cIik7XG5cbiAgICBjb25zdCBpZHMgPSBwYXJzZWQudW5pdHMubWFwKCh1OiBVbml0TWV0cmljcykgPT4gdS5pZCk7XG4gICAgYXNzZXJ0Lm9rKGlkcy5zb21lKChpZCkgPT4gaWQuc3RhcnRzV2l0aChcIk0wMDFcIikpLCBcIk0wMDEgdW5pdCBtdXN0IGJlIHByZXNlcnZlZFwiKTtcbiAgICBhc3NlcnQub2soaWRzLnNvbWUoKGlkKSA9PiBpZC5zdGFydHNXaXRoKFwiTTAwMlwiKSksIFwiTTAwMiB1bml0IG11c3QgYmUgcHJlc2VudFwiKTtcblxuICAgIHJlc2V0TWV0cmljc0J5U2NvcGUoc2NvcGUpO1xuICB9KTtcblxuICB0ZXN0KFwiaWRlbXBvdGVudCBCeVNjb3BlIHNuYXBzaG90IGRvZXMgbm90IGR1cGxpY2F0ZSB1bml0cyBvbiBkaXNrXCIsICgpID0+IHtcbiAgICBjb25zdCB3cyA9IGNyZWF0ZVdvcmtzcGFjZShwcm9qZWN0RGlyKTtcbiAgICBjb25zdCBzY29wZSA9IHNjb3BlTWlsZXN0b25lKHdzLCBcIk0wMDFcIik7XG4gICAgY29uc3QgY3R4ID0gbW9ja0N0eChbYXNzaXN0YW50TXNnKCldKTtcbiAgICBjb25zdCBzdGFydGVkQXQgPSBEYXRlLm5vdygpIC0gMzAwMDtcbiAgICBjb25zdCBtZXRyaWNzUGF0aCA9IGpvaW4od3MucHJvamVjdFJvb3QsIFwiLmdzZFwiLCBcIm1ldHJpY3MuanNvblwiKTtcblxuICAgIC8vIFNuYXBzaG90IHR3aWNlIHdpdGggc2FtZSB0eXBlK2lkK3N0YXJ0ZWRBdFxuICAgIHNuYXBzaG90VW5pdE1ldHJpY3NCeVNjb3BlKHNjb3BlLCBjdHgsIFwiZXhlY3V0ZS10YXNrXCIsIFwiTTAwMS9TMDEvVDAxXCIsIHN0YXJ0ZWRBdCwgXCJ0ZXN0LW1vZGVsXCIpO1xuICAgIHNuYXBzaG90VW5pdE1ldHJpY3NCeVNjb3BlKHNjb3BlLCBjdHgsIFwiZXhlY3V0ZS10YXNrXCIsIFwiTTAwMS9TMDEvVDAxXCIsIHN0YXJ0ZWRBdCwgXCJ0ZXN0LW1vZGVsXCIpO1xuXG4gICAgY29uc3QgcGFyc2VkOiBNZXRyaWNzTGVkZ2VyID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMobWV0cmljc1BhdGgsIFwidXRmLThcIikpO1xuICAgIGFzc2VydC5lcXVhbChwYXJzZWQudW5pdHMubGVuZ3RoLCAxLCBcImR1cGxpY2F0ZSBzbmFwc2hvdHMgbXVzdCBub3QgY3JlYXRlIGR1cGxpY2F0ZSBlbnRyaWVzXCIpO1xuXG4gICAgcmVzZXRNZXRyaWNzQnlTY29wZShzY29wZSk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFFQSxTQUFTLFVBQVUsTUFBTSxZQUFZLGlCQUFpQjtBQUN0RCxPQUFPLFlBQVk7QUFDbkI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BRUs7QUFDUCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsaUJBQWlCO0FBRTFCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUdLO0FBQ1AsU0FBUyxpQkFBaUIsc0JBQXNCO0FBSWhELFNBQVMsaUJBQXlCO0FBQ2hDLFFBQU0sTUFBTSxhQUFhLFlBQVksS0FBSyxPQUFPLEdBQUcsb0JBQW9CLENBQUMsQ0FBQztBQUMx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
