import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyUnitPhase,
  aggregateByPhase,
  aggregateBySlice,
  aggregateByModel,
  getProjectTotals,
  formatCost,
  formatTokenCount,
  initMetrics,
  resetMetrics,
  getLedger,
  snapshotUnitMetrics
} from "../metrics.js";
function makeUnit(overrides = {}) {
  return {
    type: "execute-task",
    id: "M001/S01/T01",
    model: "claude-sonnet-4-20250514",
    startedAt: 1e3,
    finishedAt: 2e3,
    tokens: { input: 1e3, output: 500, cacheRead: 200, cacheWrite: 100, total: 1800 },
    cost: 0.05,
    toolCalls: 3,
    assistantMessages: 2,
    userMessages: 1,
    ...overrides
  };
}
function mockCtx(messages = []) {
  const entries = messages.map((msg, i) => ({
    type: "message",
    id: `entry-${i}`,
    parentId: i > 0 ? `entry-${i - 1}` : null,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    message: msg
  }));
  return { sessionManager: { getEntries: () => entries }, model: { id: "claude-sonnet-4-20250514" } };
}
test("classifyUnitPhase maps unit types to phases", () => {
  assert.equal(classifyUnitPhase("research-milestone"), "research");
  assert.equal(classifyUnitPhase("research-slice"), "research");
  assert.equal(classifyUnitPhase("plan-milestone"), "planning");
  assert.equal(classifyUnitPhase("plan-slice"), "planning");
  assert.equal(classifyUnitPhase("execute-task"), "execution");
  assert.equal(classifyUnitPhase("complete-slice"), "completion");
  assert.equal(classifyUnitPhase("reassess-roadmap"), "reassessment");
  assert.equal(classifyUnitPhase("unknown-thing"), "execution");
});
test("getProjectTotals aggregates tokens, cost, duration, and tool calls", () => {
  const units = [
    makeUnit({ tokens: { input: 1e3, output: 500, cacheRead: 200, cacheWrite: 100, total: 1800 }, cost: 0.05, toolCalls: 3, startedAt: 1e3, finishedAt: 2e3 }),
    makeUnit({ tokens: { input: 2e3, output: 1e3, cacheRead: 400, cacheWrite: 200, total: 3600 }, cost: 0.1, toolCalls: 5, startedAt: 2e3, finishedAt: 4e3 })
  ];
  const totals = getProjectTotals(units);
  assert.equal(totals.units, 2);
  assert.equal(totals.tokens.input, 3e3);
  assert.equal(totals.tokens.output, 1500);
  assert.equal(totals.tokens.total, 5400);
  assert.ok(Math.abs(totals.cost - 0.15) < 1e-3);
  assert.equal(totals.toolCalls, 8);
  assert.equal(totals.duration, 3e3);
});
test("getProjectTotals handles empty input", () => {
  const totals = getProjectTotals([]);
  assert.equal(totals.units, 0);
  assert.equal(totals.cost, 0);
  assert.equal(totals.tokens.total, 0);
});
test("getProjectTotals aggregates budget fields", () => {
  const units = [
    makeUnit({ truncationSections: 3, continueHereFired: true }),
    makeUnit({ truncationSections: 2, continueHereFired: false }),
    makeUnit({ truncationSections: 1, continueHereFired: true })
  ];
  const totals = getProjectTotals(units);
  assert.equal(totals.totalTruncationSections, 6);
  assert.equal(totals.continueHereFiredCount, 2);
});
test("getProjectTotals defaults budget fields to 0 for old units", () => {
  const totals = getProjectTotals([makeUnit(), makeUnit()]);
  assert.equal(totals.totalTruncationSections, 0);
  assert.equal(totals.continueHereFiredCount, 0);
});
test("aggregateByPhase groups units by phase and sums costs", () => {
  const units = [
    makeUnit({ type: "research-milestone", cost: 0.02 }),
    makeUnit({ type: "research-slice", cost: 0.03 }),
    makeUnit({ type: "plan-milestone", cost: 0.01 }),
    makeUnit({ type: "plan-slice", cost: 0.02 }),
    makeUnit({ type: "execute-task", cost: 0.1 }),
    makeUnit({ type: "execute-task", cost: 0.08 }),
    makeUnit({ type: "complete-slice", cost: 0.01 }),
    makeUnit({ type: "reassess-roadmap", cost: 5e-3 })
  ];
  const phases = aggregateByPhase(units);
  assert.equal(phases.length, 5);
  assert.equal(phases[0].phase, "research");
  assert.equal(phases[0].units, 2);
  assert.ok(Math.abs(phases[0].cost - 0.05) < 1e-3);
  assert.equal(phases[2].phase, "execution");
  assert.ok(Math.abs(phases[2].cost - 0.18) < 1e-3);
});
test("aggregateBySlice groups units by slice ID", () => {
  const units = [
    makeUnit({ id: "M001/S01/T01", cost: 0.05 }),
    makeUnit({ id: "M001/S01/T02", cost: 0.04 }),
    makeUnit({ id: "M001/S02/T01", cost: 0.1 }),
    makeUnit({ id: "M001", type: "research-milestone", cost: 0.02 })
  ];
  const slices = aggregateBySlice(units);
  assert.equal(slices.length, 3);
  const s01 = slices.find((s) => s.sliceId === "M001/S01");
  assert.ok(s01);
  assert.equal(s01.units, 2);
  assert.ok(Math.abs(s01.cost - 0.09) < 1e-3);
});
test("aggregateByModel groups by model sorted by cost desc", () => {
  const units = [
    makeUnit({ model: "claude-sonnet-4-20250514", cost: 0.05 }),
    makeUnit({ model: "claude-sonnet-4-20250514", cost: 0.04 }),
    makeUnit({ model: "claude-opus-4-20250514", cost: 0.3 })
  ];
  const models = aggregateByModel(units);
  assert.equal(models.length, 2);
  assert.equal(models[0].model, "claude-opus-4-20250514");
  assert.equal(models[1].units, 2);
});
test("aggregateByModel picks first defined contextWindowTokens", () => {
  const units = [
    makeUnit({ model: "claude-sonnet-4-20250514", contextWindowTokens: 2e5, cost: 0.05 }),
    makeUnit({ model: "claude-sonnet-4-20250514", contextWindowTokens: 15e4, cost: 0.04 })
  ];
  const models = aggregateByModel(units);
  assert.equal(models[0].contextWindowTokens, 2e5);
});
test("formatCost formats dollar amounts correctly", () => {
  assert.equal(formatCost(0), "$0.0000");
  assert.equal(formatCost(1e-3), "$0.0010");
  assert.equal(formatCost(0.05), "$0.050");
  assert.equal(formatCost(1.5), "$1.50");
  assert.equal(formatCost(14.2), "$14.20");
});
test("formatTokenCount uses k/M suffixes", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(500), "500");
  assert.equal(formatTokenCount(1500), "1.5k");
  assert.equal(formatTokenCount(15e4), "150.0k");
  assert.equal(formatTokenCount(15e5), "1.50M");
});
test("old UnitMetrics without budget fields work with all aggregation functions", () => {
  const oldUnit = makeUnit();
  assert.equal(aggregateByPhase([oldUnit]).length, 1);
  assert.equal(aggregateBySlice([oldUnit]).length, 1);
  assert.equal(aggregateByModel([oldUnit]).length, 1);
  assert.equal(getProjectTotals([oldUnit]).units, 1);
  assert.equal(oldUnit.contextWindowTokens, void 0);
});
test("initMetrics creates ledger, snapshotUnitMetrics persists across resets", () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "gsd-metrics-test-"));
  mkdirSync(join(tmpBase, ".gsd"), { recursive: true });
  try {
    resetMetrics();
    assert.equal(getLedger(), null);
    initMetrics(tmpBase);
    const ledger = getLedger();
    assert.ok(ledger);
    assert.equal(ledger.version, 1);
    assert.equal(ledger.units.length, 0);
    const ctx = mockCtx([
      { role: "user", content: "Do the thing" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
        usage: {
          input: 5e3,
          output: 2e3,
          cacheRead: 3e3,
          cacheWrite: 500,
          totalTokens: 10500,
          cost: { input: 0.015, output: 0.03, cacheRead: 3e-3, cacheWrite: 2e-3, total: 0.05 }
        }
      }
    ]);
    const unit = snapshotUnitMetrics(ctx, "execute-task", "M001/S01/T01", Date.now() - 5e3, "claude-sonnet-4-20250514");
    assert.ok(unit);
    assert.equal(unit.type, "execute-task");
    assert.equal(unit.tokens.input, 5e3);
    resetMetrics();
    initMetrics(tmpBase);
    assert.equal(getLedger().units.length, 1);
    assert.equal(getLedger().units[0].id, "M001/S01/T01");
    const raw = readFileSync(join(tmpBase, ".gsd", "metrics.json"), "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.units.length, 1);
    const emptyUnit = snapshotUnitMetrics(mockCtx([]), "plan-slice", "M001/S01", Date.now(), "test-model");
    assert.equal(emptyUnit, null);
    assert.equal(getLedger().units.length, 1);
  } finally {
    resetMetrics();
    rmSync(tmpBase, { recursive: true, force: true });
  }
});
test("snapshotUnitMetrics deduplicates entries with same type+id+startedAt", () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "gsd-metrics-dedup-"));
  mkdirSync(join(tmpBase, ".gsd"), { recursive: true });
  try {
    initMetrics(tmpBase);
    const startedAt = Date.now() - 1e4;
    const ctx = mockCtx([
      {
        role: "assistant",
        content: [{ type: "text", text: "Working" }],
        usage: {
          input: 1e3,
          output: 500,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1500,
          cost: 0.01
        }
      }
    ]);
    const unit1 = snapshotUnitMetrics(ctx, "plan-slice", "M001/S01", startedAt, "test-model");
    assert.ok(unit1);
    assert.equal(getLedger().units.length, 1);
    const unit2 = snapshotUnitMetrics(ctx, "plan-slice", "M001/S01", startedAt, "test-model");
    assert.ok(unit2);
    assert.equal(getLedger().units.length, 1, "should still be 1 entry after duplicate snapshot");
    assert.ok(getLedger().units[0].finishedAt >= unit1.finishedAt);
    const unit3 = snapshotUnitMetrics(ctx, "plan-slice", "M001/S01", startedAt + 5e3, "test-model");
    assert.ok(unit3);
    assert.equal(getLedger().units.length, 2, "different startedAt = different execution = new entry");
    resetMetrics();
    initMetrics(tmpBase);
    assert.equal(getLedger().units.length, 2);
  } finally {
    resetMetrics();
    rmSync(tmpBase, { recursive: true, force: true });
  }
});
test("snapshotUnitMetrics handles simulated idle-watchdog duplicate pattern", () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "gsd-metrics-watchdog-"));
  mkdirSync(join(tmpBase, ".gsd"), { recursive: true });
  try {
    initMetrics(tmpBase);
    const startedAt = Date.now() - 6e4;
    const ctx = mockCtx([
      {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
        usage: {
          input: 2e3,
          output: 1e3,
          cacheRead: 500,
          cacheWrite: 100,
          totalTokens: 3600,
          cost: 0.05
        }
      }
    ]);
    for (let i = 0; i < 10; i++) {
      snapshotUnitMetrics(ctx, "plan-slice", "M001/S01", startedAt, "test-model");
    }
    assert.equal(getLedger().units.length, 1, "10 watchdog snapshots should produce 1 entry, not 10");
    const raw = readFileSync(join(tmpBase, ".gsd", "metrics.json"), "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.units.length, 1);
  } finally {
    resetMetrics();
    rmSync(tmpBase, { recursive: true, force: true });
  }
});
test("snapshotUnitMetrics counts toolCall blocks correctly (#1713)", () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "gsd-metrics-toolcall-"));
  mkdirSync(join(tmpBase, ".gsd"), { recursive: true });
  try {
    resetMetrics();
    initMetrics(tmpBase);
    const ctx = mockCtx([
      { role: "user", content: "Do something" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me help." },
          { type: "toolCall", name: "Read", input: { file: "foo.ts" } },
          { type: "toolCall", name: "Edit", input: { file: "bar.ts" } }
        ],
        usage: {
          input: 1e3,
          output: 500,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1500,
          cost: 0.01
        }
      },
      {
        role: "assistant",
        content: [
          { type: "toolCall", name: "Bash", input: { command: "ls" } },
          { type: "text", text: "All done." }
        ],
        usage: {
          input: 800,
          output: 300,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1100,
          cost: 8e-3
        }
      }
    ]);
    const unit = snapshotUnitMetrics(ctx, "execute-task", "M001/S01/T01", Date.now() - 3e3, "test-model");
    assert.ok(unit);
    assert.equal(unit.toolCalls, 3, "should count 3 toolCall blocks across 2 assistant messages");
    assert.equal(unit.assistantMessages, 2);
    assert.equal(unit.userMessages, 1);
  } finally {
    resetMetrics();
    rmSync(tmpBase, { recursive: true, force: true });
  }
});
test("#1943 initMetrics deduplicates entries loaded from a corrupted disk ledger", () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "gsd-metrics-dedup-load-"));
  mkdirSync(join(tmpBase, ".gsd"), { recursive: true });
  try {
    resetMetrics();
    const corruptedLedger = {
      version: 1,
      projectStartedAt: 17e11,
      units: [
        makeUnit({ type: "research-slice", id: "M009/S02", startedAt: 1774011016218, finishedAt: 1774011031218, cost: 1.5, tokens: { input: 66e5, output: 1e5, cacheRead: 0, cacheWrite: 0, total: 67e5 } }),
        makeUnit({ type: "research-slice", id: "M009/S02", startedAt: 1774011016218, finishedAt: 1774011046218, cost: 1.55, tokens: { input: 68e5, output: 11e4, cacheRead: 0, cacheWrite: 0, total: 691e4 } }),
        makeUnit({ type: "research-slice", id: "M009/S02", startedAt: 1774011016218, finishedAt: 1774011061218, cost: 1.6, tokens: { input: 7e6, output: 12e4, cacheRead: 0, cacheWrite: 0, total: 712e4 } }),
        makeUnit({ type: "research-slice", id: "M009/S02", startedAt: 1774011016218, finishedAt: 1774011076218, cost: 1.65, tokens: { input: 72e5, output: 13e4, cacheRead: 0, cacheWrite: 0, total: 733e4 } }),
        // A different unit — should be preserved
        makeUnit({ type: "execute-task", id: "M001/S01/T01", startedAt: 1774012e6, finishedAt: 177401206e4, cost: 0.5 })
      ]
    };
    writeFileSync(
      join(tmpBase, ".gsd", "metrics.json"),
      JSON.stringify(corruptedLedger, null, 2)
    );
    initMetrics(tmpBase);
    const ledger = getLedger();
    assert.ok(ledger);
    assert.equal(
      ledger.units.length,
      2,
      `expected 2 entries after dedup (1 collapsed group + 1 unique), got ${ledger.units.length}`
    );
    const researchEntry = ledger.units.find((u) => u.type === "research-slice");
    assert.ok(researchEntry);
    assert.equal(researchEntry.finishedAt, 1774011076218, "should keep the latest finishedAt");
    assert.equal(researchEntry.cost, 1.65, "should keep the latest cost");
    const diskRaw = readFileSync(join(tmpBase, ".gsd", "metrics.json"), "utf-8");
    const diskLedger = JSON.parse(diskRaw);
    assert.equal(diskLedger.units.length, 2, "disk should also have deduplicated entries");
  } finally {
    resetMetrics();
    rmSync(tmpBase, { recursive: true, force: true });
  }
});
test("#1943 getProjectTotals reports correct cost after dedup (no 35% inflation)", () => {
  const startedAt = 1774011016218;
  const baseCost = 1.5;
  const duplicateUnits = [];
  for (let i = 0; i < 20; i++) {
    duplicateUnits.push(makeUnit({
      type: "research-slice",
      id: "M009/S02",
      startedAt,
      finishedAt: startedAt + (i + 1) * 15e3,
      cost: baseCost + i * 0.05,
      toolCalls: 0,
      tokens: {
        input: 66e5 + i * 2e5,
        output: 1e5 + i * 1e4,
        cacheRead: 0,
        cacheWrite: 0,
        total: 67e5 + i * 21e4
      }
    }));
  }
  const rawTotals = getProjectTotals(duplicateUnits);
  const lastEntryCost = duplicateUnits[duplicateUnits.length - 1].cost;
  assert.ok(
    rawTotals.cost > lastEntryCost * 2,
    "raw totals with duplicates inflate cost (bug demonstration)"
  );
  const tmpBase = mkdtempSync(join(tmpdir(), "gsd-metrics-cost-inflation-"));
  mkdirSync(join(tmpBase, ".gsd"), { recursive: true });
  try {
    resetMetrics();
    writeFileSync(
      join(tmpBase, ".gsd", "metrics.json"),
      JSON.stringify({ version: 1, projectStartedAt: 17e11, units: duplicateUnits }, null, 2)
    );
    initMetrics(tmpBase);
    const ledger = getLedger();
    const dedupedTotals = getProjectTotals(ledger.units);
    assert.equal(ledger.units.length, 1, "20 duplicates should collapse to 1 entry");
    assert.equal(
      dedupedTotals.cost,
      lastEntryCost,
      `deduped cost should be ${lastEntryCost}, not ${dedupedTotals.cost}`
    );
  } finally {
    resetMetrics();
    rmSync(tmpBase, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9tZXRyaWNzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogTWV0cmljcyB0ZXN0cyBcdTIwMTQgY29uc29saWRhdGVkIGZyb206XG4gKiAgIC0gbWV0cmljcy50ZXN0LnRzIChwdXJlIGFnZ3JlZ2F0aW9uIGZ1bmN0aW9ucywgZm9ybWF0dGluZylcbiAqICAgLSBtZXRyaWNzLWlvLnRlc3QudHMgKGRpc2sgSS9PLCBpbml0LCBzbmFwc2hvdCwgcGVyc2lzdGVuY2UpXG4gKi9cblxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7XG4gIHR5cGUgVW5pdE1ldHJpY3MsXG4gIHR5cGUgTWV0cmljc0xlZGdlcixcbiAgY2xhc3NpZnlVbml0UGhhc2UsXG4gIGFnZ3JlZ2F0ZUJ5UGhhc2UsXG4gIGFnZ3JlZ2F0ZUJ5U2xpY2UsXG4gIGFnZ3JlZ2F0ZUJ5TW9kZWwsXG4gIGdldFByb2plY3RUb3RhbHMsXG4gIGZvcm1hdENvc3QsXG4gIGZvcm1hdFRva2VuQ291bnQsXG4gIGluaXRNZXRyaWNzLFxuICByZXNldE1ldHJpY3MsXG4gIGdldExlZGdlcixcbiAgc25hcHNob3RVbml0TWV0cmljcyxcbn0gZnJvbSBcIi4uL21ldHJpY3MuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIG1ha2VVbml0KG92ZXJyaWRlczogUGFydGlhbDxVbml0TWV0cmljcz4gPSB7fSk6IFVuaXRNZXRyaWNzIHtcbiAgcmV0dXJuIHtcbiAgICB0eXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgIGlkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgIG1vZGVsOiBcImNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNFwiLFxuICAgIHN0YXJ0ZWRBdDogMTAwMCxcbiAgICBmaW5pc2hlZEF0OiAyMDAwLFxuICAgIHRva2VuczogeyBpbnB1dDogMTAwMCwgb3V0cHV0OiA1MDAsIGNhY2hlUmVhZDogMjAwLCBjYWNoZVdyaXRlOiAxMDAsIHRvdGFsOiAxODAwIH0sXG4gICAgY29zdDogMC4wNSxcbiAgICB0b29sQ2FsbHM6IDMsXG4gICAgYXNzaXN0YW50TWVzc2FnZXM6IDIsXG4gICAgdXNlck1lc3NhZ2VzOiAxLFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbW9ja0N0eChtZXNzYWdlczogYW55W10gPSBbXSk6IGFueSB7XG4gIGNvbnN0IGVudHJpZXMgPSBtZXNzYWdlcy5tYXAoKG1zZywgaSkgPT4gKHtcbiAgICB0eXBlOiBcIm1lc3NhZ2VcIiwgaWQ6IGBlbnRyeS0ke2l9YCxcbiAgICBwYXJlbnRJZDogaSA+IDAgPyBgZW50cnktJHtpIC0gMX1gIDogbnVsbCxcbiAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSwgbWVzc2FnZTogbXNnLFxuICB9KSk7XG4gIHJldHVybiB7IHNlc3Npb25NYW5hZ2VyOiB7IGdldEVudHJpZXM6ICgpID0+IGVudHJpZXMgfSwgbW9kZWw6IHsgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0XCIgfSB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgUGhhc2UgY2xhc3NpZmljYXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJjbGFzc2lmeVVuaXRQaGFzZSBtYXBzIHVuaXQgdHlwZXMgdG8gcGhhc2VzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKGNsYXNzaWZ5VW5pdFBoYXNlKFwicmVzZWFyY2gtbWlsZXN0b25lXCIpLCBcInJlc2VhcmNoXCIpO1xuICBhc3NlcnQuZXF1YWwoY2xhc3NpZnlVbml0UGhhc2UoXCJyZXNlYXJjaC1zbGljZVwiKSwgXCJyZXNlYXJjaFwiKTtcbiAgYXNzZXJ0LmVxdWFsKGNsYXNzaWZ5VW5pdFBoYXNlKFwicGxhbi1taWxlc3RvbmVcIiksIFwicGxhbm5pbmdcIik7XG4gIGFzc2VydC5lcXVhbChjbGFzc2lmeVVuaXRQaGFzZShcInBsYW4tc2xpY2VcIiksIFwicGxhbm5pbmdcIik7XG4gIGFzc2VydC5lcXVhbChjbGFzc2lmeVVuaXRQaGFzZShcImV4ZWN1dGUtdGFza1wiKSwgXCJleGVjdXRpb25cIik7XG4gIGFzc2VydC5lcXVhbChjbGFzc2lmeVVuaXRQaGFzZShcImNvbXBsZXRlLXNsaWNlXCIpLCBcImNvbXBsZXRpb25cIik7XG4gIGFzc2VydC5lcXVhbChjbGFzc2lmeVVuaXRQaGFzZShcInJlYXNzZXNzLXJvYWRtYXBcIiksIFwicmVhc3Nlc3NtZW50XCIpO1xuICBhc3NlcnQuZXF1YWwoY2xhc3NpZnlVbml0UGhhc2UoXCJ1bmtub3duLXRoaW5nXCIpLCBcImV4ZWN1dGlvblwiKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDAgZ2V0UHJvamVjdFRvdGFscyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImdldFByb2plY3RUb3RhbHMgYWdncmVnYXRlcyB0b2tlbnMsIGNvc3QsIGR1cmF0aW9uLCBhbmQgdG9vbCBjYWxsc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHVuaXRzID0gW1xuICAgIG1ha2VVbml0KHsgdG9rZW5zOiB7IGlucHV0OiAxMDAwLCBvdXRwdXQ6IDUwMCwgY2FjaGVSZWFkOiAyMDAsIGNhY2hlV3JpdGU6IDEwMCwgdG90YWw6IDE4MDAgfSwgY29zdDogMC4wNSwgdG9vbENhbGxzOiAzLCBzdGFydGVkQXQ6IDEwMDAsIGZpbmlzaGVkQXQ6IDIwMDAgfSksXG4gICAgbWFrZVVuaXQoeyB0b2tlbnM6IHsgaW5wdXQ6IDIwMDAsIG91dHB1dDogMTAwMCwgY2FjaGVSZWFkOiA0MDAsIGNhY2hlV3JpdGU6IDIwMCwgdG90YWw6IDM2MDAgfSwgY29zdDogMC4xMCwgdG9vbENhbGxzOiA1LCBzdGFydGVkQXQ6IDIwMDAsIGZpbmlzaGVkQXQ6IDQwMDAgfSksXG4gIF07XG4gIGNvbnN0IHRvdGFscyA9IGdldFByb2plY3RUb3RhbHModW5pdHMpO1xuICBhc3NlcnQuZXF1YWwodG90YWxzLnVuaXRzLCAyKTtcbiAgYXNzZXJ0LmVxdWFsKHRvdGFscy50b2tlbnMuaW5wdXQsIDMwMDApO1xuICBhc3NlcnQuZXF1YWwodG90YWxzLnRva2Vucy5vdXRwdXQsIDE1MDApO1xuICBhc3NlcnQuZXF1YWwodG90YWxzLnRva2Vucy50b3RhbCwgNTQwMCk7XG4gIGFzc2VydC5vayhNYXRoLmFicyh0b3RhbHMuY29zdCAtIDAuMTUpIDwgMC4wMDEpO1xuICBhc3NlcnQuZXF1YWwodG90YWxzLnRvb2xDYWxscywgOCk7XG4gIGFzc2VydC5lcXVhbCh0b3RhbHMuZHVyYXRpb24sIDMwMDApO1xufSk7XG5cbnRlc3QoXCJnZXRQcm9qZWN0VG90YWxzIGhhbmRsZXMgZW1wdHkgaW5wdXRcIiwgKCkgPT4ge1xuICBjb25zdCB0b3RhbHMgPSBnZXRQcm9qZWN0VG90YWxzKFtdKTtcbiAgYXNzZXJ0LmVxdWFsKHRvdGFscy51bml0cywgMCk7XG4gIGFzc2VydC5lcXVhbCh0b3RhbHMuY29zdCwgMCk7XG4gIGFzc2VydC5lcXVhbCh0b3RhbHMudG9rZW5zLnRvdGFsLCAwKTtcbn0pO1xuXG50ZXN0KFwiZ2V0UHJvamVjdFRvdGFscyBhZ2dyZWdhdGVzIGJ1ZGdldCBmaWVsZHNcIiwgKCkgPT4ge1xuICBjb25zdCB1bml0cyA9IFtcbiAgICBtYWtlVW5pdCh7IHRydW5jYXRpb25TZWN0aW9uczogMywgY29udGludWVIZXJlRmlyZWQ6IHRydWUgfSksXG4gICAgbWFrZVVuaXQoeyB0cnVuY2F0aW9uU2VjdGlvbnM6IDIsIGNvbnRpbnVlSGVyZUZpcmVkOiBmYWxzZSB9KSxcbiAgICBtYWtlVW5pdCh7IHRydW5jYXRpb25TZWN0aW9uczogMSwgY29udGludWVIZXJlRmlyZWQ6IHRydWUgfSksXG4gIF07XG4gIGNvbnN0IHRvdGFscyA9IGdldFByb2plY3RUb3RhbHModW5pdHMpO1xuICBhc3NlcnQuZXF1YWwodG90YWxzLnRvdGFsVHJ1bmNhdGlvblNlY3Rpb25zLCA2KTtcbiAgYXNzZXJ0LmVxdWFsKHRvdGFscy5jb250aW51ZUhlcmVGaXJlZENvdW50LCAyKTtcbn0pO1xuXG50ZXN0KFwiZ2V0UHJvamVjdFRvdGFscyBkZWZhdWx0cyBidWRnZXQgZmllbGRzIHRvIDAgZm9yIG9sZCB1bml0c1wiLCAoKSA9PiB7XG4gIGNvbnN0IHRvdGFscyA9IGdldFByb2plY3RUb3RhbHMoW21ha2VVbml0KCksIG1ha2VVbml0KCldKTtcbiAgYXNzZXJ0LmVxdWFsKHRvdGFscy50b3RhbFRydW5jYXRpb25TZWN0aW9ucywgMCk7XG4gIGFzc2VydC5lcXVhbCh0b3RhbHMuY29udGludWVIZXJlRmlyZWRDb3VudCwgMCk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIGFnZ3JlZ2F0ZUJ5UGhhc2UgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJhZ2dyZWdhdGVCeVBoYXNlIGdyb3VwcyB1bml0cyBieSBwaGFzZSBhbmQgc3VtcyBjb3N0c1wiLCAoKSA9PiB7XG4gIGNvbnN0IHVuaXRzID0gW1xuICAgIG1ha2VVbml0KHsgdHlwZTogXCJyZXNlYXJjaC1taWxlc3RvbmVcIiwgY29zdDogMC4wMiB9KSxcbiAgICBtYWtlVW5pdCh7IHR5cGU6IFwicmVzZWFyY2gtc2xpY2VcIiwgY29zdDogMC4wMyB9KSxcbiAgICBtYWtlVW5pdCh7IHR5cGU6IFwicGxhbi1taWxlc3RvbmVcIiwgY29zdDogMC4wMSB9KSxcbiAgICBtYWtlVW5pdCh7IHR5cGU6IFwicGxhbi1zbGljZVwiLCBjb3N0OiAwLjAyIH0pLFxuICAgIG1ha2VVbml0KHsgdHlwZTogXCJleGVjdXRlLXRhc2tcIiwgY29zdDogMC4xMCB9KSxcbiAgICBtYWtlVW5pdCh7IHR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsIGNvc3Q6IDAuMDggfSksXG4gICAgbWFrZVVuaXQoeyB0eXBlOiBcImNvbXBsZXRlLXNsaWNlXCIsIGNvc3Q6IDAuMDEgfSksXG4gICAgbWFrZVVuaXQoeyB0eXBlOiBcInJlYXNzZXNzLXJvYWRtYXBcIiwgY29zdDogMC4wMDUgfSksXG4gIF07XG4gIGNvbnN0IHBoYXNlcyA9IGFnZ3JlZ2F0ZUJ5UGhhc2UodW5pdHMpO1xuICBhc3NlcnQuZXF1YWwocGhhc2VzLmxlbmd0aCwgNSk7XG4gIGFzc2VydC5lcXVhbChwaGFzZXNbMF0ucGhhc2UsIFwicmVzZWFyY2hcIik7XG4gIGFzc2VydC5lcXVhbChwaGFzZXNbMF0udW5pdHMsIDIpO1xuICBhc3NlcnQub2soTWF0aC5hYnMocGhhc2VzWzBdLmNvc3QgLSAwLjA1KSA8IDAuMDAxKTtcbiAgYXNzZXJ0LmVxdWFsKHBoYXNlc1syXS5waGFzZSwgXCJleGVjdXRpb25cIik7XG4gIGFzc2VydC5vayhNYXRoLmFicyhwaGFzZXNbMl0uY29zdCAtIDAuMTgpIDwgMC4wMDEpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMCBhZ2dyZWdhdGVCeVNsaWNlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiYWdncmVnYXRlQnlTbGljZSBncm91cHMgdW5pdHMgYnkgc2xpY2UgSURcIiwgKCkgPT4ge1xuICBjb25zdCB1bml0cyA9IFtcbiAgICBtYWtlVW5pdCh7IGlkOiBcIk0wMDEvUzAxL1QwMVwiLCBjb3N0OiAwLjA1IH0pLFxuICAgIG1ha2VVbml0KHsgaWQ6IFwiTTAwMS9TMDEvVDAyXCIsIGNvc3Q6IDAuMDQgfSksXG4gICAgbWFrZVVuaXQoeyBpZDogXCJNMDAxL1MwMi9UMDFcIiwgY29zdDogMC4xMCB9KSxcbiAgICBtYWtlVW5pdCh7IGlkOiBcIk0wMDFcIiwgdHlwZTogXCJyZXNlYXJjaC1taWxlc3RvbmVcIiwgY29zdDogMC4wMiB9KSxcbiAgXTtcbiAgY29uc3Qgc2xpY2VzID0gYWdncmVnYXRlQnlTbGljZSh1bml0cyk7XG4gIGFzc2VydC5lcXVhbChzbGljZXMubGVuZ3RoLCAzKTtcbiAgY29uc3QgczAxID0gc2xpY2VzLmZpbmQocyA9PiBzLnNsaWNlSWQgPT09IFwiTTAwMS9TMDFcIik7XG4gIGFzc2VydC5vayhzMDEpO1xuICBhc3NlcnQuZXF1YWwoczAxIS51bml0cywgMik7XG4gIGFzc2VydC5vayhNYXRoLmFicyhzMDEhLmNvc3QgLSAwLjA5KSA8IDAuMDAxKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDAgYWdncmVnYXRlQnlNb2RlbCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImFnZ3JlZ2F0ZUJ5TW9kZWwgZ3JvdXBzIGJ5IG1vZGVsIHNvcnRlZCBieSBjb3N0IGRlc2NcIiwgKCkgPT4ge1xuICBjb25zdCB1bml0cyA9IFtcbiAgICBtYWtlVW5pdCh7IG1vZGVsOiBcImNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNFwiLCBjb3N0OiAwLjA1IH0pLFxuICAgIG1ha2VVbml0KHsgbW9kZWw6IFwiY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0XCIsIGNvc3Q6IDAuMDQgfSksXG4gICAgbWFrZVVuaXQoeyBtb2RlbDogXCJjbGF1ZGUtb3B1cy00LTIwMjUwNTE0XCIsIGNvc3Q6IDAuMzAgfSksXG4gIF07XG4gIGNvbnN0IG1vZGVscyA9IGFnZ3JlZ2F0ZUJ5TW9kZWwodW5pdHMpO1xuICBhc3NlcnQuZXF1YWwobW9kZWxzLmxlbmd0aCwgMik7XG4gIGFzc2VydC5lcXVhbChtb2RlbHNbMF0ubW9kZWwsIFwiY2xhdWRlLW9wdXMtNC0yMDI1MDUxNFwiKTtcbiAgYXNzZXJ0LmVxdWFsKG1vZGVsc1sxXS51bml0cywgMik7XG59KTtcblxudGVzdChcImFnZ3JlZ2F0ZUJ5TW9kZWwgcGlja3MgZmlyc3QgZGVmaW5lZCBjb250ZXh0V2luZG93VG9rZW5zXCIsICgpID0+IHtcbiAgY29uc3QgdW5pdHMgPSBbXG4gICAgbWFrZVVuaXQoeyBtb2RlbDogXCJjbGF1ZGUtc29ubmV0LTQtMjAyNTA1MTRcIiwgY29udGV4dFdpbmRvd1Rva2VuczogMjAwMDAwLCBjb3N0OiAwLjA1IH0pLFxuICAgIG1ha2VVbml0KHsgbW9kZWw6IFwiY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0XCIsIGNvbnRleHRXaW5kb3dUb2tlbnM6IDE1MDAwMCwgY29zdDogMC4wNCB9KSxcbiAgXTtcbiAgY29uc3QgbW9kZWxzID0gYWdncmVnYXRlQnlNb2RlbCh1bml0cyk7XG4gIGFzc2VydC5lcXVhbChtb2RlbHNbMF0uY29udGV4dFdpbmRvd1Rva2VucywgMjAwMDAwKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDAgRm9ybWF0dGluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImZvcm1hdENvc3QgZm9ybWF0cyBkb2xsYXIgYW1vdW50cyBjb3JyZWN0bHlcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoZm9ybWF0Q29zdCgwKSwgXCIkMC4wMDAwXCIpO1xuICBhc3NlcnQuZXF1YWwoZm9ybWF0Q29zdCgwLjAwMSksIFwiJDAuMDAxMFwiKTtcbiAgYXNzZXJ0LmVxdWFsKGZvcm1hdENvc3QoMC4wNSksIFwiJDAuMDUwXCIpO1xuICBhc3NlcnQuZXF1YWwoZm9ybWF0Q29zdCgxLjUwKSwgXCIkMS41MFwiKTtcbiAgYXNzZXJ0LmVxdWFsKGZvcm1hdENvc3QoMTQuMjApLCBcIiQxNC4yMFwiKTtcbn0pO1xuXG50ZXN0KFwiZm9ybWF0VG9rZW5Db3VudCB1c2VzIGsvTSBzdWZmaXhlc1wiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChmb3JtYXRUb2tlbkNvdW50KDApLCBcIjBcIik7XG4gIGFzc2VydC5lcXVhbChmb3JtYXRUb2tlbkNvdW50KDUwMCksIFwiNTAwXCIpO1xuICBhc3NlcnQuZXF1YWwoZm9ybWF0VG9rZW5Db3VudCgxNTAwKSwgXCIxLjVrXCIpO1xuICBhc3NlcnQuZXF1YWwoZm9ybWF0VG9rZW5Db3VudCgxNTAwMDApLCBcIjE1MC4wa1wiKTtcbiAgYXNzZXJ0LmVxdWFsKGZvcm1hdFRva2VuQ291bnQoMTUwMDAwMCksIFwiMS41ME1cIik7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIEJhY2t3YXJkIGNvbXBhdGliaWxpdHkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJvbGQgVW5pdE1ldHJpY3Mgd2l0aG91dCBidWRnZXQgZmllbGRzIHdvcmsgd2l0aCBhbGwgYWdncmVnYXRpb24gZnVuY3Rpb25zXCIsICgpID0+IHtcbiAgY29uc3Qgb2xkVW5pdCA9IG1ha2VVbml0KCk7XG4gIGFzc2VydC5lcXVhbChhZ2dyZWdhdGVCeVBoYXNlKFtvbGRVbml0XSkubGVuZ3RoLCAxKTtcbiAgYXNzZXJ0LmVxdWFsKGFnZ3JlZ2F0ZUJ5U2xpY2UoW29sZFVuaXRdKS5sZW5ndGgsIDEpO1xuICBhc3NlcnQuZXF1YWwoYWdncmVnYXRlQnlNb2RlbChbb2xkVW5pdF0pLmxlbmd0aCwgMSk7XG4gIGFzc2VydC5lcXVhbChnZXRQcm9qZWN0VG90YWxzKFtvbGRVbml0XSkudW5pdHMsIDEpO1xuICBhc3NlcnQuZXF1YWwob2xkVW5pdC5jb250ZXh0V2luZG93VG9rZW5zLCB1bmRlZmluZWQpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMCBEaXNrIEkvTyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImluaXRNZXRyaWNzIGNyZWF0ZXMgbGVkZ2VyLCBzbmFwc2hvdFVuaXRNZXRyaWNzIHBlcnNpc3RzIGFjcm9zcyByZXNldHNcIiwgKCkgPT4ge1xuICBjb25zdCB0bXBCYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtbWV0cmljcy10ZXN0LVwiKSk7XG4gIG1rZGlyU3luYyhqb2luKHRtcEJhc2UsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgdHJ5IHtcbiAgICByZXNldE1ldHJpY3MoKTtcbiAgICBhc3NlcnQuZXF1YWwoZ2V0TGVkZ2VyKCksIG51bGwpO1xuXG4gICAgaW5pdE1ldHJpY3ModG1wQmFzZSk7XG4gICAgY29uc3QgbGVkZ2VyID0gZ2V0TGVkZ2VyKCk7XG4gICAgYXNzZXJ0Lm9rKGxlZGdlcik7XG4gICAgYXNzZXJ0LmVxdWFsKGxlZGdlciEudmVyc2lvbiwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKGxlZGdlciEudW5pdHMubGVuZ3RoLCAwKTtcblxuICAgIC8vIFNuYXBzaG90IGEgdW5pdFxuICAgIGNvbnN0IGN0eCA9IG1vY2tDdHgoW1xuICAgICAgeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogXCJEbyB0aGUgdGhpbmdcIiB9LFxuICAgICAge1xuICAgICAgICByb2xlOiBcImFzc2lzdGFudFwiLFxuICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJEb25lXCIgfV0sXG4gICAgICAgIHVzYWdlOiB7XG4gICAgICAgICAgaW5wdXQ6IDUwMDAsIG91dHB1dDogMjAwMCwgY2FjaGVSZWFkOiAzMDAwLCBjYWNoZVdyaXRlOiA1MDAsIHRvdGFsVG9rZW5zOiAxMDUwMCxcbiAgICAgICAgICBjb3N0OiB7IGlucHV0OiAwLjAxNSwgb3V0cHV0OiAwLjAzLCBjYWNoZVJlYWQ6IDAuMDAzLCBjYWNoZVdyaXRlOiAwLjAwMiwgdG90YWw6IDAuMDUgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgXSk7XG4gICAgY29uc3QgdW5pdCA9IHNuYXBzaG90VW5pdE1ldHJpY3MoY3R4LCBcImV4ZWN1dGUtdGFza1wiLCBcIk0wMDEvUzAxL1QwMVwiLCBEYXRlLm5vdygpIC0gNTAwMCwgXCJjbGF1ZGUtc29ubmV0LTQtMjAyNTA1MTRcIik7XG4gICAgYXNzZXJ0Lm9rKHVuaXQpO1xuICAgIGFzc2VydC5lcXVhbCh1bml0IS50eXBlLCBcImV4ZWN1dGUtdGFza1wiKTtcbiAgICBhc3NlcnQuZXF1YWwodW5pdCEudG9rZW5zLmlucHV0LCA1MDAwKTtcblxuICAgIC8vIFBlcnNpc3QgYW5kIHJlbG9hZFxuICAgIHJlc2V0TWV0cmljcygpO1xuICAgIGluaXRNZXRyaWNzKHRtcEJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChnZXRMZWRnZXIoKSEudW5pdHMubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwoZ2V0TGVkZ2VyKCkhLnVuaXRzWzBdLmlkLCBcIk0wMDEvUzAxL1QwMVwiKTtcblxuICAgIC8vIFZlcmlmeSBmaWxlIGNvbnRlbnRcbiAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoam9pbih0bXBCYXNlLCBcIi5nc2RcIiwgXCJtZXRyaWNzLmpzb25cIiksIFwidXRmLThcIik7XG4gICAgY29uc3QgcGFyc2VkOiBNZXRyaWNzTGVkZ2VyID0gSlNPTi5wYXJzZShyYXcpO1xuICAgIGFzc2VydC5lcXVhbChwYXJzZWQudmVyc2lvbiwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKHBhcnNlZC51bml0cy5sZW5ndGgsIDEpO1xuXG4gICAgLy8gRW1wdHkgc2Vzc2lvbiByZXR1cm5zIG51bGxcbiAgICBjb25zdCBlbXB0eVVuaXQgPSBzbmFwc2hvdFVuaXRNZXRyaWNzKG1vY2tDdHgoW10pLCBcInBsYW4tc2xpY2VcIiwgXCJNMDAxL1MwMVwiLCBEYXRlLm5vdygpLCBcInRlc3QtbW9kZWxcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGVtcHR5VW5pdCwgbnVsbCk7XG4gICAgYXNzZXJ0LmVxdWFsKGdldExlZGdlcigpIS51bml0cy5sZW5ndGgsIDEpO1xuICB9IGZpbmFsbHkge1xuICAgIHJlc2V0TWV0cmljcygpO1xuICAgIHJtU3luYyh0bXBCYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDAgc25hcHNob3RVbml0TWV0cmljcyBpZGVtcG90ZW5jeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInNuYXBzaG90VW5pdE1ldHJpY3MgZGVkdXBsaWNhdGVzIGVudHJpZXMgd2l0aCBzYW1lIHR5cGUraWQrc3RhcnRlZEF0XCIsICgpID0+IHtcbiAgY29uc3QgdG1wQmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLW1ldHJpY3MtZGVkdXAtXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4odG1wQmFzZSwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgdHJ5IHtcbiAgICBpbml0TWV0cmljcyh0bXBCYXNlKTtcbiAgICBjb25zdCBzdGFydGVkQXQgPSBEYXRlLm5vdygpIC0gMTAwMDA7XG4gICAgY29uc3QgY3R4ID0gbW9ja0N0eChbXG4gICAgICB7XG4gICAgICAgIHJvbGU6IFwiYXNzaXN0YW50XCIsXG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIldvcmtpbmdcIiB9XSxcbiAgICAgICAgdXNhZ2U6IHtcbiAgICAgICAgICBpbnB1dDogMTAwMCwgb3V0cHV0OiA1MDAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCwgdG90YWxUb2tlbnM6IDE1MDAsXG4gICAgICAgICAgY29zdDogMC4wMSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgXSk7XG5cbiAgICAvLyBGaXJzdCBzbmFwc2hvdCBcdTIwMTQgc2hvdWxkIGNyZWF0ZSBlbnRyeVxuICAgIGNvbnN0IHVuaXQxID0gc25hcHNob3RVbml0TWV0cmljcyhjdHgsIFwicGxhbi1zbGljZVwiLCBcIk0wMDEvUzAxXCIsIHN0YXJ0ZWRBdCwgXCJ0ZXN0LW1vZGVsXCIpO1xuICAgIGFzc2VydC5vayh1bml0MSk7XG4gICAgYXNzZXJ0LmVxdWFsKGdldExlZGdlcigpIS51bml0cy5sZW5ndGgsIDEpO1xuXG4gICAgLy8gU2Vjb25kIHNuYXBzaG90IHdpdGggc2FtZSB0eXBlK2lkK3N0YXJ0ZWRBdCBcdTIwMTQgc2hvdWxkIFVQREFURSwgbm90IGFwcGVuZFxuICAgIGNvbnN0IHVuaXQyID0gc25hcHNob3RVbml0TWV0cmljcyhjdHgsIFwicGxhbi1zbGljZVwiLCBcIk0wMDEvUzAxXCIsIHN0YXJ0ZWRBdCwgXCJ0ZXN0LW1vZGVsXCIpO1xuICAgIGFzc2VydC5vayh1bml0Mik7XG4gICAgYXNzZXJ0LmVxdWFsKGdldExlZGdlcigpIS51bml0cy5sZW5ndGgsIDEsIFwic2hvdWxkIHN0aWxsIGJlIDEgZW50cnkgYWZ0ZXIgZHVwbGljYXRlIHNuYXBzaG90XCIpO1xuXG4gICAgLy8gVGhlIGVudHJ5IHNob3VsZCBoYXZlIHRoZSBsYXRlc3QgZmluaXNoZWRBdFxuICAgIGFzc2VydC5vayhnZXRMZWRnZXIoKSEudW5pdHNbMF0uZmluaXNoZWRBdCA+PSB1bml0MSEuZmluaXNoZWRBdCk7XG5cbiAgICAvLyBEaWZmZXJlbnQgc3RhcnRlZEF0IFx1MjAxNCBzaG91bGQgY3JlYXRlIGEgTkVXIGVudHJ5IChkaWZmZXJlbnQgZXhlY3V0aW9uKVxuICAgIGNvbnN0IHVuaXQzID0gc25hcHNob3RVbml0TWV0cmljcyhjdHgsIFwicGxhbi1zbGljZVwiLCBcIk0wMDEvUzAxXCIsIHN0YXJ0ZWRBdCArIDUwMDAsIFwidGVzdC1tb2RlbFwiKTtcbiAgICBhc3NlcnQub2sodW5pdDMpO1xuICAgIGFzc2VydC5lcXVhbChnZXRMZWRnZXIoKSEudW5pdHMubGVuZ3RoLCAyLCBcImRpZmZlcmVudCBzdGFydGVkQXQgPSBkaWZmZXJlbnQgZXhlY3V0aW9uID0gbmV3IGVudHJ5XCIpO1xuXG4gICAgLy8gUGVyc2lzdCBhbmQgdmVyaWZ5IG9uIGRpc2tcbiAgICByZXNldE1ldHJpY3MoKTtcbiAgICBpbml0TWV0cmljcyh0bXBCYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwoZ2V0TGVkZ2VyKCkhLnVuaXRzLmxlbmd0aCwgMik7XG4gIH0gZmluYWxseSB7XG4gICAgcmVzZXRNZXRyaWNzKCk7XG4gICAgcm1TeW5jKHRtcEJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJzbmFwc2hvdFVuaXRNZXRyaWNzIGhhbmRsZXMgc2ltdWxhdGVkIGlkbGUtd2F0Y2hkb2cgZHVwbGljYXRlIHBhdHRlcm5cIiwgKCkgPT4ge1xuICBjb25zdCB0bXBCYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtbWV0cmljcy13YXRjaGRvZy1cIikpO1xuICBta2RpclN5bmMoam9pbih0bXBCYXNlLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB0cnkge1xuICAgIGluaXRNZXRyaWNzKHRtcEJhc2UpO1xuICAgIGNvbnN0IHN0YXJ0ZWRBdCA9IERhdGUubm93KCkgLSA2MDAwMDtcbiAgICBjb25zdCBjdHggPSBtb2NrQ3R4KFtcbiAgICAgIHtcbiAgICAgICAgcm9sZTogXCJhc3Npc3RhbnRcIixcbiAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiRG9uZVwiIH1dLFxuICAgICAgICB1c2FnZToge1xuICAgICAgICAgIGlucHV0OiAyMDAwLCBvdXRwdXQ6IDEwMDAsIGNhY2hlUmVhZDogNTAwLCBjYWNoZVdyaXRlOiAxMDAsIHRvdGFsVG9rZW5zOiAzNjAwLFxuICAgICAgICAgIGNvc3Q6IDAuMDUsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIF0pO1xuXG4gICAgLy8gU2ltdWxhdGUgd2F0Y2hkb2cgY2FsbGluZyBjbG9zZW91dFVuaXQgKHdoaWNoIGNhbGxzIHNuYXBzaG90VW5pdE1ldHJpY3MpXG4gICAgLy8gMTAgdGltZXMgYXQgMTVzIGludGVydmFscyBcdTIwMTQgbWltaWNraW5nIHRoZSBidWcgc2NlbmFyaW9cbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDEwOyBpKyspIHtcbiAgICAgIHNuYXBzaG90VW5pdE1ldHJpY3MoY3R4LCBcInBsYW4tc2xpY2VcIiwgXCJNMDAxL1MwMVwiLCBzdGFydGVkQXQsIFwidGVzdC1tb2RlbFwiKTtcbiAgICB9XG5cbiAgICAvLyBTaG91bGQgc3RpbGwgYmUgZXhhY3RseSAxIGVudHJ5LCBub3QgMTBcbiAgICBhc3NlcnQuZXF1YWwoZ2V0TGVkZ2VyKCkhLnVuaXRzLmxlbmd0aCwgMSwgXCIxMCB3YXRjaGRvZyBzbmFwc2hvdHMgc2hvdWxkIHByb2R1Y2UgMSBlbnRyeSwgbm90IDEwXCIpO1xuXG4gICAgLy8gUGVyc2lzdCBhbmQgdmVyaWZ5XG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGpvaW4odG1wQmFzZSwgXCIuZ3NkXCIsIFwibWV0cmljcy5qc29uXCIpLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHBhcnNlZDogTWV0cmljc0xlZGdlciA9IEpTT04ucGFyc2UocmF3KTtcbiAgICBhc3NlcnQuZXF1YWwocGFyc2VkLnVuaXRzLmxlbmd0aCwgMSk7XG4gIH0gZmluYWxseSB7XG4gICAgcmVzZXRNZXRyaWNzKCk7XG4gICAgcm1TeW5jKHRtcEJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMCB0b29sQ2FsbCBibG9jayBjb3VudGluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInNuYXBzaG90VW5pdE1ldHJpY3MgY291bnRzIHRvb2xDYWxsIGJsb2NrcyBjb3JyZWN0bHkgKCMxNzEzKVwiLCAoKSA9PiB7XG4gIGNvbnN0IHRtcEJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1tZXRyaWNzLXRvb2xjYWxsLVwiKSk7XG4gIG1rZGlyU3luYyhqb2luKHRtcEJhc2UsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgdHJ5IHtcbiAgICByZXNldE1ldHJpY3MoKTtcbiAgICBpbml0TWV0cmljcyh0bXBCYXNlKTtcblxuICAgIGNvbnN0IGN0eCA9IG1vY2tDdHgoW1xuICAgICAgeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogXCJEbyBzb21ldGhpbmdcIiB9LFxuICAgICAge1xuICAgICAgICByb2xlOiBcImFzc2lzdGFudFwiLFxuICAgICAgICBjb250ZW50OiBbXG4gICAgICAgICAgeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJMZXQgbWUgaGVscC5cIiB9LFxuICAgICAgICAgIHsgdHlwZTogXCJ0b29sQ2FsbFwiLCBuYW1lOiBcIlJlYWRcIiwgaW5wdXQ6IHsgZmlsZTogXCJmb28udHNcIiB9IH0sXG4gICAgICAgICAgeyB0eXBlOiBcInRvb2xDYWxsXCIsIG5hbWU6IFwiRWRpdFwiLCBpbnB1dDogeyBmaWxlOiBcImJhci50c1wiIH0gfSxcbiAgICAgICAgXSxcbiAgICAgICAgdXNhZ2U6IHtcbiAgICAgICAgICBpbnB1dDogMTAwMCwgb3V0cHV0OiA1MDAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCwgdG90YWxUb2tlbnM6IDE1MDAsXG4gICAgICAgICAgY29zdDogMC4wMSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIHJvbGU6IFwiYXNzaXN0YW50XCIsXG4gICAgICAgIGNvbnRlbnQ6IFtcbiAgICAgICAgICB7IHR5cGU6IFwidG9vbENhbGxcIiwgbmFtZTogXCJCYXNoXCIsIGlucHV0OiB7IGNvbW1hbmQ6IFwibHNcIiB9IH0sXG4gICAgICAgICAgeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJBbGwgZG9uZS5cIiB9LFxuICAgICAgICBdLFxuICAgICAgICB1c2FnZToge1xuICAgICAgICAgIGlucHV0OiA4MDAsIG91dHB1dDogMzAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIHRvdGFsVG9rZW5zOiAxMTAwLFxuICAgICAgICAgIGNvc3Q6IDAuMDA4LFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICBdKTtcblxuICAgIGNvbnN0IHVuaXQgPSBzbmFwc2hvdFVuaXRNZXRyaWNzKGN0eCwgXCJleGVjdXRlLXRhc2tcIiwgXCJNMDAxL1MwMS9UMDFcIiwgRGF0ZS5ub3coKSAtIDMwMDAsIFwidGVzdC1tb2RlbFwiKTtcbiAgICBhc3NlcnQub2sodW5pdCk7XG4gICAgYXNzZXJ0LmVxdWFsKHVuaXQhLnRvb2xDYWxscywgMywgXCJzaG91bGQgY291bnQgMyB0b29sQ2FsbCBibG9ja3MgYWNyb3NzIDIgYXNzaXN0YW50IG1lc3NhZ2VzXCIpO1xuICAgIGFzc2VydC5lcXVhbCh1bml0IS5hc3Npc3RhbnRNZXNzYWdlcywgMik7XG4gICAgYXNzZXJ0LmVxdWFsKHVuaXQhLnVzZXJNZXNzYWdlcywgMSk7XG4gIH0gZmluYWxseSB7XG4gICAgcmVzZXRNZXRyaWNzKCk7XG4gICAgcm1TeW5jKHRtcEJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMCAjMTk0MyBcdTIwMTQgRHVwbGljYXRlIG1ldHJpY3MgZW50cmllcyBmcm9tIGlkbGUgd2F0Y2hkb2cgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCIjMTk0MyBpbml0TWV0cmljcyBkZWR1cGxpY2F0ZXMgZW50cmllcyBsb2FkZWQgZnJvbSBhIGNvcnJ1cHRlZCBkaXNrIGxlZGdlclwiLCAoKSA9PiB7XG4gIGNvbnN0IHRtcEJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1tZXRyaWNzLWRlZHVwLWxvYWQtXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4odG1wQmFzZSwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICB0cnkge1xuICAgIHJlc2V0TWV0cmljcygpO1xuXG4gICAgLy8gU2ltdWxhdGUgYSBjb3JydXB0ZWQgbWV0cmljcy5qc29uIHdpdGggZHVwbGljYXRlIGVudHJpZXMgb24gZGlza1xuICAgIC8vIChzYW1lIHR5cGUraWQrc3RhcnRlZEF0IGJ1dCBkaWZmZXJlbnQgZmluaXNoZWRBdCBcdTIwMTQgaWRsZSB3YXRjaGRvZyBwYXR0ZXJuKVxuICAgIGNvbnN0IGNvcnJ1cHRlZExlZGdlcjogTWV0cmljc0xlZGdlciA9IHtcbiAgICAgIHZlcnNpb246IDEsXG4gICAgICBwcm9qZWN0U3RhcnRlZEF0OiAxNzAwMDAwMDAwMDAwLFxuICAgICAgdW5pdHM6IFtcbiAgICAgICAgbWFrZVVuaXQoeyB0eXBlOiBcInJlc2VhcmNoLXNsaWNlXCIsIGlkOiBcIk0wMDkvUzAyXCIsIHN0YXJ0ZWRBdDogMTc3NDAxMTAxNjIxOCwgZmluaXNoZWRBdDogMTc3NDAxMTAzMTIxOCwgY29zdDogMS41MCwgdG9rZW5zOiB7IGlucHV0OiA2NjAwMDAwLCBvdXRwdXQ6IDEwMDAwMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCB0b3RhbDogNjcwMDAwMCB9IH0pLFxuICAgICAgICBtYWtlVW5pdCh7IHR5cGU6IFwicmVzZWFyY2gtc2xpY2VcIiwgaWQ6IFwiTTAwOS9TMDJcIiwgc3RhcnRlZEF0OiAxNzc0MDExMDE2MjE4LCBmaW5pc2hlZEF0OiAxNzc0MDExMDQ2MjE4LCBjb3N0OiAxLjU1LCB0b2tlbnM6IHsgaW5wdXQ6IDY4MDAwMDAsIG91dHB1dDogMTEwMDAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIHRvdGFsOiA2OTEwMDAwIH0gfSksXG4gICAgICAgIG1ha2VVbml0KHsgdHlwZTogXCJyZXNlYXJjaC1zbGljZVwiLCBpZDogXCJNMDA5L1MwMlwiLCBzdGFydGVkQXQ6IDE3NzQwMTEwMTYyMTgsIGZpbmlzaGVkQXQ6IDE3NzQwMTEwNjEyMTgsIGNvc3Q6IDEuNjAsIHRva2VuczogeyBpbnB1dDogNzAwMDAwMCwgb3V0cHV0OiAxMjAwMDAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCwgdG90YWw6IDcxMjAwMDAgfSB9KSxcbiAgICAgICAgbWFrZVVuaXQoeyB0eXBlOiBcInJlc2VhcmNoLXNsaWNlXCIsIGlkOiBcIk0wMDkvUzAyXCIsIHN0YXJ0ZWRBdDogMTc3NDAxMTAxNjIxOCwgZmluaXNoZWRBdDogMTc3NDAxMTA3NjIxOCwgY29zdDogMS42NSwgdG9rZW5zOiB7IGlucHV0OiA3MjAwMDAwLCBvdXRwdXQ6IDEzMDAwMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCB0b3RhbDogNzMzMDAwMCB9IH0pLFxuICAgICAgICAvLyBBIGRpZmZlcmVudCB1bml0IFx1MjAxNCBzaG91bGQgYmUgcHJlc2VydmVkXG4gICAgICAgIG1ha2VVbml0KHsgdHlwZTogXCJleGVjdXRlLXRhc2tcIiwgaWQ6IFwiTTAwMS9TMDEvVDAxXCIsIHN0YXJ0ZWRBdDogMTc3NDAxMjAwMDAwMCwgZmluaXNoZWRBdDogMTc3NDAxMjA2MDAwMCwgY29zdDogMC41MCB9KSxcbiAgICAgIF0sXG4gICAgfTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbih0bXBCYXNlLCBcIi5nc2RcIiwgXCJtZXRyaWNzLmpzb25cIiksXG4gICAgICBKU09OLnN0cmluZ2lmeShjb3JydXB0ZWRMZWRnZXIsIG51bGwsIDIpLFxuICAgICk7XG5cbiAgICAvLyBMb2FkIHRoZSBjb3JydXB0ZWQgbGVkZ2VyIFx1MjAxNCBkdXBsaWNhdGVzIHNob3VsZCBiZSBjb2xsYXBzZWQgb24gbG9hZFxuICAgIGluaXRNZXRyaWNzKHRtcEJhc2UpO1xuICAgIGNvbnN0IGxlZGdlciA9IGdldExlZGdlcigpO1xuICAgIGFzc2VydC5vayhsZWRnZXIpO1xuXG4gICAgLy8gVGhlIDQgZW50cmllcyB3aXRoIGlkZW50aWNhbCAodHlwZSwgaWQsIHN0YXJ0ZWRBdCkgc2hvdWxkIGNvbGxhcHNlIHRvIDEsXG4gICAgLy8ga2VlcGluZyB0aGUgbGF0ZXN0IChoaWdoZXN0IGZpbmlzaGVkQXQpLiBQbHVzIHRoZSAxIGRpZmZlcmVudCB1bml0ID0gMiB0b3RhbC5cbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBsZWRnZXIhLnVuaXRzLmxlbmd0aCwgMixcbiAgICAgIGBleHBlY3RlZCAyIGVudHJpZXMgYWZ0ZXIgZGVkdXAgKDEgY29sbGFwc2VkIGdyb3VwICsgMSB1bmlxdWUpLCBnb3QgJHtsZWRnZXIhLnVuaXRzLmxlbmd0aH1gLFxuICAgICk7XG5cbiAgICAvLyBUaGUgc3Vydml2aW5nIGR1cGxpY2F0ZSBzaG91bGQgYmUgdGhlIG9uZSB3aXRoIHRoZSBsYXRlc3QgZmluaXNoZWRBdFxuICAgIGNvbnN0IHJlc2VhcmNoRW50cnkgPSBsZWRnZXIhLnVuaXRzLmZpbmQodSA9PiB1LnR5cGUgPT09IFwicmVzZWFyY2gtc2xpY2VcIik7XG4gICAgYXNzZXJ0Lm9rKHJlc2VhcmNoRW50cnkpO1xuICAgIGFzc2VydC5lcXVhbChyZXNlYXJjaEVudHJ5IS5maW5pc2hlZEF0LCAxNzc0MDExMDc2MjE4LCBcInNob3VsZCBrZWVwIHRoZSBsYXRlc3QgZmluaXNoZWRBdFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzZWFyY2hFbnRyeSEuY29zdCwgMS42NSwgXCJzaG91bGQga2VlcCB0aGUgbGF0ZXN0IGNvc3RcIik7XG5cbiAgICAvLyBUaGUgb24tZGlzayBmaWxlIHNob3VsZCBhbHNvIGJlIGRlZHVwbGljYXRlZFxuICAgIGNvbnN0IGRpc2tSYXcgPSByZWFkRmlsZVN5bmMoam9pbih0bXBCYXNlLCBcIi5nc2RcIiwgXCJtZXRyaWNzLmpzb25cIiksIFwidXRmLThcIik7XG4gICAgY29uc3QgZGlza0xlZGdlcjogTWV0cmljc0xlZGdlciA9IEpTT04ucGFyc2UoZGlza1Jhdyk7XG4gICAgYXNzZXJ0LmVxdWFsKGRpc2tMZWRnZXIudW5pdHMubGVuZ3RoLCAyLCBcImRpc2sgc2hvdWxkIGFsc28gaGF2ZSBkZWR1cGxpY2F0ZWQgZW50cmllc1wiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICByZXNldE1ldHJpY3MoKTtcbiAgICBybVN5bmModG1wQmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcIiMxOTQzIGdldFByb2plY3RUb3RhbHMgcmVwb3J0cyBjb3JyZWN0IGNvc3QgYWZ0ZXIgZGVkdXAgKG5vIDM1JSBpbmZsYXRpb24pXCIsICgpID0+IHtcbiAgLy8gU2ltdWxhdGUgdGhlIGV4YWN0IHNjZW5hcmlvIGZyb20gdGhlIGlzc3VlOiAyMCBlbnRyaWVzIGZvciBhIHNpbmdsZSBkaXNwYXRjaFxuICAvLyB3aXRoIG1vbm90b25pY2FsbHkgaW5jcmVhc2luZyB0b2tlbiBjb3VudHMgYW5kIDE1cy1hcGFydCBmaW5pc2hlZEF0IHZhbHVlc1xuICBjb25zdCBzdGFydGVkQXQgPSAxNzc0MDExMDE2MjE4O1xuICBjb25zdCBiYXNlQ29zdCA9IDEuNTA7XG4gIGNvbnN0IGR1cGxpY2F0ZVVuaXRzOiBVbml0TWV0cmljc1tdID0gW107XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCAyMDsgaSsrKSB7XG4gICAgZHVwbGljYXRlVW5pdHMucHVzaChtYWtlVW5pdCh7XG4gICAgICB0eXBlOiBcInJlc2VhcmNoLXNsaWNlXCIsXG4gICAgICBpZDogXCJNMDA5L1MwMlwiLFxuICAgICAgc3RhcnRlZEF0LFxuICAgICAgZmluaXNoZWRBdDogc3RhcnRlZEF0ICsgKGkgKyAxKSAqIDE1MDAwLFxuICAgICAgY29zdDogYmFzZUNvc3QgKyBpICogMC4wNSxcbiAgICAgIHRvb2xDYWxsczogMCxcbiAgICAgIHRva2Vuczoge1xuICAgICAgICBpbnB1dDogNjYwMDAwMCArIGkgKiAyMDAwMDAsXG4gICAgICAgIG91dHB1dDogMTAwMDAwICsgaSAqIDEwMDAwLFxuICAgICAgICBjYWNoZVJlYWQ6IDAsXG4gICAgICAgIGNhY2hlV3JpdGU6IDAsXG4gICAgICAgIHRvdGFsOiA2NzAwMDAwICsgaSAqIDIxMDAwMCxcbiAgICAgIH0sXG4gICAgfSkpO1xuICB9XG5cbiAgLy8gV2l0aG91dCBkZWR1cCwgZ2V0UHJvamVjdFRvdGFscyB3b3VsZCBzdW0gYWxsIDIwIGVudHJpZXMnIGNvc3RzXG4gIGNvbnN0IHJhd1RvdGFscyA9IGdldFByb2plY3RUb3RhbHMoZHVwbGljYXRlVW5pdHMpO1xuICAvLyBXaXRoIGRlZHVwIChvbmx5IGxhc3QgZW50cnkgc2hvdWxkIGNvdW50KSwgY29zdCBzaG91bGQgYmUgdGhlIGxhc3QgZW50cnkncyBjb3N0XG4gIGNvbnN0IGxhc3RFbnRyeUNvc3QgPSBkdXBsaWNhdGVVbml0c1tkdXBsaWNhdGVVbml0cy5sZW5ndGggLSAxXS5jb3N0O1xuXG4gIC8vIFRoaXMgdGVzdCBkb2N1bWVudHMgdGhlIGJ1ZzogcmF3IHRvdGFscyBpbmZsYXRlIGNvc3QgYnkgc3VtbWluZyBkdXBsaWNhdGVzXG4gIGFzc2VydC5vayhcbiAgICByYXdUb3RhbHMuY29zdCA+IGxhc3RFbnRyeUNvc3QgKiAyLFxuICAgIFwicmF3IHRvdGFscyB3aXRoIGR1cGxpY2F0ZXMgaW5mbGF0ZSBjb3N0IChidWcgZGVtb25zdHJhdGlvbilcIixcbiAgKTtcblxuICAvLyBBZnRlciBsb2FkaW5nIHRocm91Z2ggaW5pdE1ldHJpY3MgKHdoaWNoIHNob3VsZCBkZWR1cCksIHRvdGFscyBzaG91bGQgYmUgY29ycmVjdFxuICBjb25zdCB0bXBCYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtbWV0cmljcy1jb3N0LWluZmxhdGlvbi1cIikpO1xuICBta2RpclN5bmMoam9pbih0bXBCYXNlLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB0cnkge1xuICAgIHJlc2V0TWV0cmljcygpO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHRtcEJhc2UsIFwiLmdzZFwiLCBcIm1ldHJpY3MuanNvblwiKSxcbiAgICAgIEpTT04uc3RyaW5naWZ5KHsgdmVyc2lvbjogMSwgcHJvamVjdFN0YXJ0ZWRBdDogMTcwMDAwMDAwMDAwMCwgdW5pdHM6IGR1cGxpY2F0ZVVuaXRzIH0sIG51bGwsIDIpLFxuICAgICk7XG4gICAgaW5pdE1ldHJpY3ModG1wQmFzZSk7XG4gICAgY29uc3QgbGVkZ2VyID0gZ2V0TGVkZ2VyKCkhO1xuICAgIGNvbnN0IGRlZHVwZWRUb3RhbHMgPSBnZXRQcm9qZWN0VG90YWxzKGxlZGdlci51bml0cyk7XG4gICAgYXNzZXJ0LmVxdWFsKGxlZGdlci51bml0cy5sZW5ndGgsIDEsIFwiMjAgZHVwbGljYXRlcyBzaG91bGQgY29sbGFwc2UgdG8gMSBlbnRyeVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBkZWR1cGVkVG90YWxzLmNvc3QsIGxhc3RFbnRyeUNvc3QsXG4gICAgICBgZGVkdXBlZCBjb3N0IHNob3VsZCBiZSAke2xhc3RFbnRyeUNvc3R9LCBub3QgJHtkZWR1cGVkVG90YWxzLmNvc3R9YCxcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIHJlc2V0TWV0cmljcygpO1xuICAgIHJtU3luYyh0bXBCYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBTUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxjQUFjLFFBQVEscUJBQXFCO0FBQzVFLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkI7QUFBQSxFQUdFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFJUCxTQUFTLFNBQVMsWUFBa0MsQ0FBQyxHQUFnQjtBQUNuRSxTQUFPO0FBQUEsSUFDTCxNQUFNO0FBQUEsSUFDTixJQUFJO0FBQUEsSUFDSixPQUFPO0FBQUEsSUFDUCxXQUFXO0FBQUEsSUFDWCxZQUFZO0FBQUEsSUFDWixRQUFRLEVBQUUsT0FBTyxLQUFNLFFBQVEsS0FBSyxXQUFXLEtBQUssWUFBWSxLQUFLLE9BQU8sS0FBSztBQUFBLElBQ2pGLE1BQU07QUFBQSxJQUNOLFdBQVc7QUFBQSxJQUNYLG1CQUFtQjtBQUFBLElBQ25CLGNBQWM7QUFBQSxJQUNkLEdBQUc7QUFBQSxFQUNMO0FBQ0Y7QUFFQSxTQUFTLFFBQVEsV0FBa0IsQ0FBQyxHQUFRO0FBQzFDLFFBQU0sVUFBVSxTQUFTLElBQUksQ0FBQyxLQUFLLE9BQU87QUFBQSxJQUN4QyxNQUFNO0FBQUEsSUFBVyxJQUFJLFNBQVMsQ0FBQztBQUFBLElBQy9CLFVBQVUsSUFBSSxJQUFJLFNBQVMsSUFBSSxDQUFDLEtBQUs7QUFBQSxJQUNyQyxZQUFXLG9CQUFJLEtBQUssR0FBRSxZQUFZO0FBQUEsSUFBRyxTQUFTO0FBQUEsRUFDaEQsRUFBRTtBQUNGLFNBQU8sRUFBRSxnQkFBZ0IsRUFBRSxZQUFZLE1BQU0sUUFBUSxHQUFHLE9BQU8sRUFBRSxJQUFJLDJCQUEyQixFQUFFO0FBQ3BHO0FBSUEsS0FBSywrQ0FBK0MsTUFBTTtBQUN4RCxTQUFPLE1BQU0sa0JBQWtCLG9CQUFvQixHQUFHLFVBQVU7QUFDaEUsU0FBTyxNQUFNLGtCQUFrQixnQkFBZ0IsR0FBRyxVQUFVO0FBQzVELFNBQU8sTUFBTSxrQkFBa0IsZ0JBQWdCLEdBQUcsVUFBVTtBQUM1RCxTQUFPLE1BQU0sa0JBQWtCLFlBQVksR0FBRyxVQUFVO0FBQ3hELFNBQU8sTUFBTSxrQkFBa0IsY0FBYyxHQUFHLFdBQVc7QUFDM0QsU0FBTyxNQUFNLGtCQUFrQixnQkFBZ0IsR0FBRyxZQUFZO0FBQzlELFNBQU8sTUFBTSxrQkFBa0Isa0JBQWtCLEdBQUcsY0FBYztBQUNsRSxTQUFPLE1BQU0sa0JBQWtCLGVBQWUsR0FBRyxXQUFXO0FBQzlELENBQUM7QUFJRCxLQUFLLHNFQUFzRSxNQUFNO0FBQy9FLFFBQU0sUUFBUTtBQUFBLElBQ1osU0FBUyxFQUFFLFFBQVEsRUFBRSxPQUFPLEtBQU0sUUFBUSxLQUFLLFdBQVcsS0FBSyxZQUFZLEtBQUssT0FBTyxLQUFLLEdBQUcsTUFBTSxNQUFNLFdBQVcsR0FBRyxXQUFXLEtBQU0sWUFBWSxJQUFLLENBQUM7QUFBQSxJQUM1SixTQUFTLEVBQUUsUUFBUSxFQUFFLE9BQU8sS0FBTSxRQUFRLEtBQU0sV0FBVyxLQUFLLFlBQVksS0FBSyxPQUFPLEtBQUssR0FBRyxNQUFNLEtBQU0sV0FBVyxHQUFHLFdBQVcsS0FBTSxZQUFZLElBQUssQ0FBQztBQUFBLEVBQy9KO0FBQ0EsUUFBTSxTQUFTLGlCQUFpQixLQUFLO0FBQ3JDLFNBQU8sTUFBTSxPQUFPLE9BQU8sQ0FBQztBQUM1QixTQUFPLE1BQU0sT0FBTyxPQUFPLE9BQU8sR0FBSTtBQUN0QyxTQUFPLE1BQU0sT0FBTyxPQUFPLFFBQVEsSUFBSTtBQUN2QyxTQUFPLE1BQU0sT0FBTyxPQUFPLE9BQU8sSUFBSTtBQUN0QyxTQUFPLEdBQUcsS0FBSyxJQUFJLE9BQU8sT0FBTyxJQUFJLElBQUksSUFBSztBQUM5QyxTQUFPLE1BQU0sT0FBTyxXQUFXLENBQUM7QUFDaEMsU0FBTyxNQUFNLE9BQU8sVUFBVSxHQUFJO0FBQ3BDLENBQUM7QUFFRCxLQUFLLHdDQUF3QyxNQUFNO0FBQ2pELFFBQU0sU0FBUyxpQkFBaUIsQ0FBQyxDQUFDO0FBQ2xDLFNBQU8sTUFBTSxPQUFPLE9BQU8sQ0FBQztBQUM1QixTQUFPLE1BQU0sT0FBTyxNQUFNLENBQUM7QUFDM0IsU0FBTyxNQUFNLE9BQU8sT0FBTyxPQUFPLENBQUM7QUFDckMsQ0FBQztBQUVELEtBQUssNkNBQTZDLE1BQU07QUFDdEQsUUFBTSxRQUFRO0FBQUEsSUFDWixTQUFTLEVBQUUsb0JBQW9CLEdBQUcsbUJBQW1CLEtBQUssQ0FBQztBQUFBLElBQzNELFNBQVMsRUFBRSxvQkFBb0IsR0FBRyxtQkFBbUIsTUFBTSxDQUFDO0FBQUEsSUFDNUQsU0FBUyxFQUFFLG9CQUFvQixHQUFHLG1CQUFtQixLQUFLLENBQUM7QUFBQSxFQUM3RDtBQUNBLFFBQU0sU0FBUyxpQkFBaUIsS0FBSztBQUNyQyxTQUFPLE1BQU0sT0FBTyx5QkFBeUIsQ0FBQztBQUM5QyxTQUFPLE1BQU0sT0FBTyx3QkFBd0IsQ0FBQztBQUMvQyxDQUFDO0FBRUQsS0FBSyw4REFBOEQsTUFBTTtBQUN2RSxRQUFNLFNBQVMsaUJBQWlCLENBQUMsU0FBUyxHQUFHLFNBQVMsQ0FBQyxDQUFDO0FBQ3hELFNBQU8sTUFBTSxPQUFPLHlCQUF5QixDQUFDO0FBQzlDLFNBQU8sTUFBTSxPQUFPLHdCQUF3QixDQUFDO0FBQy9DLENBQUM7QUFJRCxLQUFLLHlEQUF5RCxNQUFNO0FBQ2xFLFFBQU0sUUFBUTtBQUFBLElBQ1osU0FBUyxFQUFFLE1BQU0sc0JBQXNCLE1BQU0sS0FBSyxDQUFDO0FBQUEsSUFDbkQsU0FBUyxFQUFFLE1BQU0sa0JBQWtCLE1BQU0sS0FBSyxDQUFDO0FBQUEsSUFDL0MsU0FBUyxFQUFFLE1BQU0sa0JBQWtCLE1BQU0sS0FBSyxDQUFDO0FBQUEsSUFDL0MsU0FBUyxFQUFFLE1BQU0sY0FBYyxNQUFNLEtBQUssQ0FBQztBQUFBLElBQzNDLFNBQVMsRUFBRSxNQUFNLGdCQUFnQixNQUFNLElBQUssQ0FBQztBQUFBLElBQzdDLFNBQVMsRUFBRSxNQUFNLGdCQUFnQixNQUFNLEtBQUssQ0FBQztBQUFBLElBQzdDLFNBQVMsRUFBRSxNQUFNLGtCQUFrQixNQUFNLEtBQUssQ0FBQztBQUFBLElBQy9DLFNBQVMsRUFBRSxNQUFNLG9CQUFvQixNQUFNLEtBQU0sQ0FBQztBQUFBLEVBQ3BEO0FBQ0EsUUFBTSxTQUFTLGlCQUFpQixLQUFLO0FBQ3JDLFNBQU8sTUFBTSxPQUFPLFFBQVEsQ0FBQztBQUM3QixTQUFPLE1BQU0sT0FBTyxDQUFDLEVBQUUsT0FBTyxVQUFVO0FBQ3hDLFNBQU8sTUFBTSxPQUFPLENBQUMsRUFBRSxPQUFPLENBQUM7QUFDL0IsU0FBTyxHQUFHLEtBQUssSUFBSSxPQUFPLENBQUMsRUFBRSxPQUFPLElBQUksSUFBSSxJQUFLO0FBQ2pELFNBQU8sTUFBTSxPQUFPLENBQUMsRUFBRSxPQUFPLFdBQVc7QUFDekMsU0FBTyxHQUFHLEtBQUssSUFBSSxPQUFPLENBQUMsRUFBRSxPQUFPLElBQUksSUFBSSxJQUFLO0FBQ25ELENBQUM7QUFJRCxLQUFLLDZDQUE2QyxNQUFNO0FBQ3RELFFBQU0sUUFBUTtBQUFBLElBQ1osU0FBUyxFQUFFLElBQUksZ0JBQWdCLE1BQU0sS0FBSyxDQUFDO0FBQUEsSUFDM0MsU0FBUyxFQUFFLElBQUksZ0JBQWdCLE1BQU0sS0FBSyxDQUFDO0FBQUEsSUFDM0MsU0FBUyxFQUFFLElBQUksZ0JBQWdCLE1BQU0sSUFBSyxDQUFDO0FBQUEsSUFDM0MsU0FBUyxFQUFFLElBQUksUUFBUSxNQUFNLHNCQUFzQixNQUFNLEtBQUssQ0FBQztBQUFBLEVBQ2pFO0FBQ0EsUUFBTSxTQUFTLGlCQUFpQixLQUFLO0FBQ3JDLFNBQU8sTUFBTSxPQUFPLFFBQVEsQ0FBQztBQUM3QixRQUFNLE1BQU0sT0FBTyxLQUFLLE9BQUssRUFBRSxZQUFZLFVBQVU7QUFDckQsU0FBTyxHQUFHLEdBQUc7QUFDYixTQUFPLE1BQU0sSUFBSyxPQUFPLENBQUM7QUFDMUIsU0FBTyxHQUFHLEtBQUssSUFBSSxJQUFLLE9BQU8sSUFBSSxJQUFJLElBQUs7QUFDOUMsQ0FBQztBQUlELEtBQUssd0RBQXdELE1BQU07QUFDakUsUUFBTSxRQUFRO0FBQUEsSUFDWixTQUFTLEVBQUUsT0FBTyw0QkFBNEIsTUFBTSxLQUFLLENBQUM7QUFBQSxJQUMxRCxTQUFTLEVBQUUsT0FBTyw0QkFBNEIsTUFBTSxLQUFLLENBQUM7QUFBQSxJQUMxRCxTQUFTLEVBQUUsT0FBTywwQkFBMEIsTUFBTSxJQUFLLENBQUM7QUFBQSxFQUMxRDtBQUNBLFFBQU0sU0FBUyxpQkFBaUIsS0FBSztBQUNyQyxTQUFPLE1BQU0sT0FBTyxRQUFRLENBQUM7QUFDN0IsU0FBTyxNQUFNLE9BQU8sQ0FBQyxFQUFFLE9BQU8sd0JBQXdCO0FBQ3RELFNBQU8sTUFBTSxPQUFPLENBQUMsRUFBRSxPQUFPLENBQUM7QUFDakMsQ0FBQztBQUVELEtBQUssNERBQTRELE1BQU07QUFDckUsUUFBTSxRQUFRO0FBQUEsSUFDWixTQUFTLEVBQUUsT0FBTyw0QkFBNEIscUJBQXFCLEtBQVEsTUFBTSxLQUFLLENBQUM7QUFBQSxJQUN2RixTQUFTLEVBQUUsT0FBTyw0QkFBNEIscUJBQXFCLE1BQVEsTUFBTSxLQUFLLENBQUM7QUFBQSxFQUN6RjtBQUNBLFFBQU0sU0FBUyxpQkFBaUIsS0FBSztBQUNyQyxTQUFPLE1BQU0sT0FBTyxDQUFDLEVBQUUscUJBQXFCLEdBQU07QUFDcEQsQ0FBQztBQUlELEtBQUssK0NBQStDLE1BQU07QUFDeEQsU0FBTyxNQUFNLFdBQVcsQ0FBQyxHQUFHLFNBQVM7QUFDckMsU0FBTyxNQUFNLFdBQVcsSUFBSyxHQUFHLFNBQVM7QUFDekMsU0FBTyxNQUFNLFdBQVcsSUFBSSxHQUFHLFFBQVE7QUFDdkMsU0FBTyxNQUFNLFdBQVcsR0FBSSxHQUFHLE9BQU87QUFDdEMsU0FBTyxNQUFNLFdBQVcsSUFBSyxHQUFHLFFBQVE7QUFDMUMsQ0FBQztBQUVELEtBQUssc0NBQXNDLE1BQU07QUFDL0MsU0FBTyxNQUFNLGlCQUFpQixDQUFDLEdBQUcsR0FBRztBQUNyQyxTQUFPLE1BQU0saUJBQWlCLEdBQUcsR0FBRyxLQUFLO0FBQ3pDLFNBQU8sTUFBTSxpQkFBaUIsSUFBSSxHQUFHLE1BQU07QUFDM0MsU0FBTyxNQUFNLGlCQUFpQixJQUFNLEdBQUcsUUFBUTtBQUMvQyxTQUFPLE1BQU0saUJBQWlCLElBQU8sR0FBRyxPQUFPO0FBQ2pELENBQUM7QUFJRCxLQUFLLDZFQUE2RSxNQUFNO0FBQ3RGLFFBQU0sVUFBVSxTQUFTO0FBQ3pCLFNBQU8sTUFBTSxpQkFBaUIsQ0FBQyxPQUFPLENBQUMsRUFBRSxRQUFRLENBQUM7QUFDbEQsU0FBTyxNQUFNLGlCQUFpQixDQUFDLE9BQU8sQ0FBQyxFQUFFLFFBQVEsQ0FBQztBQUNsRCxTQUFPLE1BQU0saUJBQWlCLENBQUMsT0FBTyxDQUFDLEVBQUUsUUFBUSxDQUFDO0FBQ2xELFNBQU8sTUFBTSxpQkFBaUIsQ0FBQyxPQUFPLENBQUMsRUFBRSxPQUFPLENBQUM7QUFDakQsU0FBTyxNQUFNLFFBQVEscUJBQXFCLE1BQVM7QUFDckQsQ0FBQztBQUlELEtBQUssMEVBQTBFLE1BQU07QUFDbkYsUUFBTSxVQUFVLFlBQVksS0FBSyxPQUFPLEdBQUcsbUJBQW1CLENBQUM7QUFDL0QsWUFBVSxLQUFLLFNBQVMsTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFFcEQsTUFBSTtBQUNGLGlCQUFhO0FBQ2IsV0FBTyxNQUFNLFVBQVUsR0FBRyxJQUFJO0FBRTlCLGdCQUFZLE9BQU87QUFDbkIsVUFBTSxTQUFTLFVBQVU7QUFDekIsV0FBTyxHQUFHLE1BQU07QUFDaEIsV0FBTyxNQUFNLE9BQVEsU0FBUyxDQUFDO0FBQy9CLFdBQU8sTUFBTSxPQUFRLE1BQU0sUUFBUSxDQUFDO0FBR3BDLFVBQU0sTUFBTSxRQUFRO0FBQUEsTUFDbEIsRUFBRSxNQUFNLFFBQVEsU0FBUyxlQUFlO0FBQUEsTUFDeEM7QUFBQSxRQUNFLE1BQU07QUFBQSxRQUNOLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLE9BQU8sQ0FBQztBQUFBLFFBQ3hDLE9BQU87QUFBQSxVQUNMLE9BQU87QUFBQSxVQUFNLFFBQVE7QUFBQSxVQUFNLFdBQVc7QUFBQSxVQUFNLFlBQVk7QUFBQSxVQUFLLGFBQWE7QUFBQSxVQUMxRSxNQUFNLEVBQUUsT0FBTyxPQUFPLFFBQVEsTUFBTSxXQUFXLE1BQU8sWUFBWSxNQUFPLE9BQU8sS0FBSztBQUFBLFFBQ3ZGO0FBQUEsTUFDRjtBQUFBLElBQ0YsQ0FBQztBQUNELFVBQU0sT0FBTyxvQkFBb0IsS0FBSyxnQkFBZ0IsZ0JBQWdCLEtBQUssSUFBSSxJQUFJLEtBQU0sMEJBQTBCO0FBQ25ILFdBQU8sR0FBRyxJQUFJO0FBQ2QsV0FBTyxNQUFNLEtBQU0sTUFBTSxjQUFjO0FBQ3ZDLFdBQU8sTUFBTSxLQUFNLE9BQU8sT0FBTyxHQUFJO0FBR3JDLGlCQUFhO0FBQ2IsZ0JBQVksT0FBTztBQUNuQixXQUFPLE1BQU0sVUFBVSxFQUFHLE1BQU0sUUFBUSxDQUFDO0FBQ3pDLFdBQU8sTUFBTSxVQUFVLEVBQUcsTUFBTSxDQUFDLEVBQUUsSUFBSSxjQUFjO0FBR3JELFVBQU0sTUFBTSxhQUFhLEtBQUssU0FBUyxRQUFRLGNBQWMsR0FBRyxPQUFPO0FBQ3ZFLFVBQU0sU0FBd0IsS0FBSyxNQUFNLEdBQUc7QUFDNUMsV0FBTyxNQUFNLE9BQU8sU0FBUyxDQUFDO0FBQzlCLFdBQU8sTUFBTSxPQUFPLE1BQU0sUUFBUSxDQUFDO0FBR25DLFVBQU0sWUFBWSxvQkFBb0IsUUFBUSxDQUFDLENBQUMsR0FBRyxjQUFjLFlBQVksS0FBSyxJQUFJLEdBQUcsWUFBWTtBQUNyRyxXQUFPLE1BQU0sV0FBVyxJQUFJO0FBQzVCLFdBQU8sTUFBTSxVQUFVLEVBQUcsTUFBTSxRQUFRLENBQUM7QUFBQSxFQUMzQyxVQUFFO0FBQ0EsaUJBQWE7QUFDYixXQUFPLFNBQVMsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUNsRDtBQUNGLENBQUM7QUFJRCxLQUFLLHdFQUF3RSxNQUFNO0FBQ2pGLFFBQU0sVUFBVSxZQUFZLEtBQUssT0FBTyxHQUFHLG9CQUFvQixDQUFDO0FBQ2hFLFlBQVUsS0FBSyxTQUFTLE1BQU0sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3BELE1BQUk7QUFDRixnQkFBWSxPQUFPO0FBQ25CLFVBQU0sWUFBWSxLQUFLLElBQUksSUFBSTtBQUMvQixVQUFNLE1BQU0sUUFBUTtBQUFBLE1BQ2xCO0FBQUEsUUFDRSxNQUFNO0FBQUEsUUFDTixTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxVQUFVLENBQUM7QUFBQSxRQUMzQyxPQUFPO0FBQUEsVUFDTCxPQUFPO0FBQUEsVUFBTSxRQUFRO0FBQUEsVUFBSyxXQUFXO0FBQUEsVUFBRyxZQUFZO0FBQUEsVUFBRyxhQUFhO0FBQUEsVUFDcEUsTUFBTTtBQUFBLFFBQ1I7QUFBQSxNQUNGO0FBQUEsSUFDRixDQUFDO0FBR0QsVUFBTSxRQUFRLG9CQUFvQixLQUFLLGNBQWMsWUFBWSxXQUFXLFlBQVk7QUFDeEYsV0FBTyxHQUFHLEtBQUs7QUFDZixXQUFPLE1BQU0sVUFBVSxFQUFHLE1BQU0sUUFBUSxDQUFDO0FBR3pDLFVBQU0sUUFBUSxvQkFBb0IsS0FBSyxjQUFjLFlBQVksV0FBVyxZQUFZO0FBQ3hGLFdBQU8sR0FBRyxLQUFLO0FBQ2YsV0FBTyxNQUFNLFVBQVUsRUFBRyxNQUFNLFFBQVEsR0FBRyxrREFBa0Q7QUFHN0YsV0FBTyxHQUFHLFVBQVUsRUFBRyxNQUFNLENBQUMsRUFBRSxjQUFjLE1BQU8sVUFBVTtBQUcvRCxVQUFNLFFBQVEsb0JBQW9CLEtBQUssY0FBYyxZQUFZLFlBQVksS0FBTSxZQUFZO0FBQy9GLFdBQU8sR0FBRyxLQUFLO0FBQ2YsV0FBTyxNQUFNLFVBQVUsRUFBRyxNQUFNLFFBQVEsR0FBRyx1REFBdUQ7QUFHbEcsaUJBQWE7QUFDYixnQkFBWSxPQUFPO0FBQ25CLFdBQU8sTUFBTSxVQUFVLEVBQUcsTUFBTSxRQUFRLENBQUM7QUFBQSxFQUMzQyxVQUFFO0FBQ0EsaUJBQWE7QUFDYixXQUFPLFNBQVMsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUNsRDtBQUNGLENBQUM7QUFFRCxLQUFLLHlFQUF5RSxNQUFNO0FBQ2xGLFFBQU0sVUFBVSxZQUFZLEtBQUssT0FBTyxHQUFHLHVCQUF1QixDQUFDO0FBQ25FLFlBQVUsS0FBSyxTQUFTLE1BQU0sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3BELE1BQUk7QUFDRixnQkFBWSxPQUFPO0FBQ25CLFVBQU0sWUFBWSxLQUFLLElBQUksSUFBSTtBQUMvQixVQUFNLE1BQU0sUUFBUTtBQUFBLE1BQ2xCO0FBQUEsUUFDRSxNQUFNO0FBQUEsUUFDTixTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxPQUFPLENBQUM7QUFBQSxRQUN4QyxPQUFPO0FBQUEsVUFDTCxPQUFPO0FBQUEsVUFBTSxRQUFRO0FBQUEsVUFBTSxXQUFXO0FBQUEsVUFBSyxZQUFZO0FBQUEsVUFBSyxhQUFhO0FBQUEsVUFDekUsTUFBTTtBQUFBLFFBQ1I7QUFBQSxNQUNGO0FBQUEsSUFDRixDQUFDO0FBSUQsYUFBUyxJQUFJLEdBQUcsSUFBSSxJQUFJLEtBQUs7QUFDM0IsMEJBQW9CLEtBQUssY0FBYyxZQUFZLFdBQVcsWUFBWTtBQUFBLElBQzVFO0FBR0EsV0FBTyxNQUFNLFVBQVUsRUFBRyxNQUFNLFFBQVEsR0FBRyxzREFBc0Q7QUFHakcsVUFBTSxNQUFNLGFBQWEsS0FBSyxTQUFTLFFBQVEsY0FBYyxHQUFHLE9BQU87QUFDdkUsVUFBTSxTQUF3QixLQUFLLE1BQU0sR0FBRztBQUM1QyxXQUFPLE1BQU0sT0FBTyxNQUFNLFFBQVEsQ0FBQztBQUFBLEVBQ3JDLFVBQUU7QUFDQSxpQkFBYTtBQUNiLFdBQU8sU0FBUyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQ2xEO0FBQ0YsQ0FBQztBQUlELEtBQUssZ0VBQWdFLE1BQU07QUFDekUsUUFBTSxVQUFVLFlBQVksS0FBSyxPQUFPLEdBQUcsdUJBQXVCLENBQUM7QUFDbkUsWUFBVSxLQUFLLFNBQVMsTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFFcEQsTUFBSTtBQUNGLGlCQUFhO0FBQ2IsZ0JBQVksT0FBTztBQUVuQixVQUFNLE1BQU0sUUFBUTtBQUFBLE1BQ2xCLEVBQUUsTUFBTSxRQUFRLFNBQVMsZUFBZTtBQUFBLE1BQ3hDO0FBQUEsUUFDRSxNQUFNO0FBQUEsUUFDTixTQUFTO0FBQUEsVUFDUCxFQUFFLE1BQU0sUUFBUSxNQUFNLGVBQWU7QUFBQSxVQUNyQyxFQUFFLE1BQU0sWUFBWSxNQUFNLFFBQVEsT0FBTyxFQUFFLE1BQU0sU0FBUyxFQUFFO0FBQUEsVUFDNUQsRUFBRSxNQUFNLFlBQVksTUFBTSxRQUFRLE9BQU8sRUFBRSxNQUFNLFNBQVMsRUFBRTtBQUFBLFFBQzlEO0FBQUEsUUFDQSxPQUFPO0FBQUEsVUFDTCxPQUFPO0FBQUEsVUFBTSxRQUFRO0FBQUEsVUFBSyxXQUFXO0FBQUEsVUFBRyxZQUFZO0FBQUEsVUFBRyxhQUFhO0FBQUEsVUFDcEUsTUFBTTtBQUFBLFFBQ1I7QUFBQSxNQUNGO0FBQUEsTUFDQTtBQUFBLFFBQ0UsTUFBTTtBQUFBLFFBQ04sU0FBUztBQUFBLFVBQ1AsRUFBRSxNQUFNLFlBQVksTUFBTSxRQUFRLE9BQU8sRUFBRSxTQUFTLEtBQUssRUFBRTtBQUFBLFVBQzNELEVBQUUsTUFBTSxRQUFRLE1BQU0sWUFBWTtBQUFBLFFBQ3BDO0FBQUEsUUFDQSxPQUFPO0FBQUEsVUFDTCxPQUFPO0FBQUEsVUFBSyxRQUFRO0FBQUEsVUFBSyxXQUFXO0FBQUEsVUFBRyxZQUFZO0FBQUEsVUFBRyxhQUFhO0FBQUEsVUFDbkUsTUFBTTtBQUFBLFFBQ1I7QUFBQSxNQUNGO0FBQUEsSUFDRixDQUFDO0FBRUQsVUFBTSxPQUFPLG9CQUFvQixLQUFLLGdCQUFnQixnQkFBZ0IsS0FBSyxJQUFJLElBQUksS0FBTSxZQUFZO0FBQ3JHLFdBQU8sR0FBRyxJQUFJO0FBQ2QsV0FBTyxNQUFNLEtBQU0sV0FBVyxHQUFHLDREQUE0RDtBQUM3RixXQUFPLE1BQU0sS0FBTSxtQkFBbUIsQ0FBQztBQUN2QyxXQUFPLE1BQU0sS0FBTSxjQUFjLENBQUM7QUFBQSxFQUNwQyxVQUFFO0FBQ0EsaUJBQWE7QUFDYixXQUFPLFNBQVMsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUNsRDtBQUNGLENBQUM7QUFJRCxLQUFLLDhFQUE4RSxNQUFNO0FBQ3ZGLFFBQU0sVUFBVSxZQUFZLEtBQUssT0FBTyxHQUFHLHlCQUF5QixDQUFDO0FBQ3JFLFlBQVUsS0FBSyxTQUFTLE1BQU0sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBRXBELE1BQUk7QUFDRixpQkFBYTtBQUliLFVBQU0sa0JBQWlDO0FBQUEsTUFDckMsU0FBUztBQUFBLE1BQ1Qsa0JBQWtCO0FBQUEsTUFDbEIsT0FBTztBQUFBLFFBQ0wsU0FBUyxFQUFFLE1BQU0sa0JBQWtCLElBQUksWUFBWSxXQUFXLGVBQWUsWUFBWSxlQUFlLE1BQU0sS0FBTSxRQUFRLEVBQUUsT0FBTyxNQUFTLFFBQVEsS0FBUSxXQUFXLEdBQUcsWUFBWSxHQUFHLE9BQU8sS0FBUSxFQUFFLENBQUM7QUFBQSxRQUM3TSxTQUFTLEVBQUUsTUFBTSxrQkFBa0IsSUFBSSxZQUFZLFdBQVcsZUFBZSxZQUFZLGVBQWUsTUFBTSxNQUFNLFFBQVEsRUFBRSxPQUFPLE1BQVMsUUFBUSxNQUFRLFdBQVcsR0FBRyxZQUFZLEdBQUcsT0FBTyxNQUFRLEVBQUUsQ0FBQztBQUFBLFFBQzdNLFNBQVMsRUFBRSxNQUFNLGtCQUFrQixJQUFJLFlBQVksV0FBVyxlQUFlLFlBQVksZUFBZSxNQUFNLEtBQU0sUUFBUSxFQUFFLE9BQU8sS0FBUyxRQUFRLE1BQVEsV0FBVyxHQUFHLFlBQVksR0FBRyxPQUFPLE1BQVEsRUFBRSxDQUFDO0FBQUEsUUFDN00sU0FBUyxFQUFFLE1BQU0sa0JBQWtCLElBQUksWUFBWSxXQUFXLGVBQWUsWUFBWSxlQUFlLE1BQU0sTUFBTSxRQUFRLEVBQUUsT0FBTyxNQUFTLFFBQVEsTUFBUSxXQUFXLEdBQUcsWUFBWSxHQUFHLE9BQU8sTUFBUSxFQUFFLENBQUM7QUFBQTtBQUFBLFFBRTdNLFNBQVMsRUFBRSxNQUFNLGdCQUFnQixJQUFJLGdCQUFnQixXQUFXLFdBQWUsWUFBWSxhQUFlLE1BQU0sSUFBSyxDQUFDO0FBQUEsTUFDeEg7QUFBQSxJQUNGO0FBQ0E7QUFBQSxNQUNFLEtBQUssU0FBUyxRQUFRLGNBQWM7QUFBQSxNQUNwQyxLQUFLLFVBQVUsaUJBQWlCLE1BQU0sQ0FBQztBQUFBLElBQ3pDO0FBR0EsZ0JBQVksT0FBTztBQUNuQixVQUFNLFNBQVMsVUFBVTtBQUN6QixXQUFPLEdBQUcsTUFBTTtBQUloQixXQUFPO0FBQUEsTUFDTCxPQUFRLE1BQU07QUFBQSxNQUFRO0FBQUEsTUFDdEIsc0VBQXNFLE9BQVEsTUFBTSxNQUFNO0FBQUEsSUFDNUY7QUFHQSxVQUFNLGdCQUFnQixPQUFRLE1BQU0sS0FBSyxPQUFLLEVBQUUsU0FBUyxnQkFBZ0I7QUFDekUsV0FBTyxHQUFHLGFBQWE7QUFDdkIsV0FBTyxNQUFNLGNBQWUsWUFBWSxlQUFlLG1DQUFtQztBQUMxRixXQUFPLE1BQU0sY0FBZSxNQUFNLE1BQU0sNkJBQTZCO0FBR3JFLFVBQU0sVUFBVSxhQUFhLEtBQUssU0FBUyxRQUFRLGNBQWMsR0FBRyxPQUFPO0FBQzNFLFVBQU0sYUFBNEIsS0FBSyxNQUFNLE9BQU87QUFDcEQsV0FBTyxNQUFNLFdBQVcsTUFBTSxRQUFRLEdBQUcsNENBQTRDO0FBQUEsRUFDdkYsVUFBRTtBQUNBLGlCQUFhO0FBQ2IsV0FBTyxTQUFTLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDbEQ7QUFDRixDQUFDO0FBRUQsS0FBSyw4RUFBOEUsTUFBTTtBQUd2RixRQUFNLFlBQVk7QUFDbEIsUUFBTSxXQUFXO0FBQ2pCLFFBQU0saUJBQWdDLENBQUM7QUFFdkMsV0FBUyxJQUFJLEdBQUcsSUFBSSxJQUFJLEtBQUs7QUFDM0IsbUJBQWUsS0FBSyxTQUFTO0FBQUEsTUFDM0IsTUFBTTtBQUFBLE1BQ04sSUFBSTtBQUFBLE1BQ0o7QUFBQSxNQUNBLFlBQVksYUFBYSxJQUFJLEtBQUs7QUFBQSxNQUNsQyxNQUFNLFdBQVcsSUFBSTtBQUFBLE1BQ3JCLFdBQVc7QUFBQSxNQUNYLFFBQVE7QUFBQSxRQUNOLE9BQU8sT0FBVSxJQUFJO0FBQUEsUUFDckIsUUFBUSxNQUFTLElBQUk7QUFBQSxRQUNyQixXQUFXO0FBQUEsUUFDWCxZQUFZO0FBQUEsUUFDWixPQUFPLE9BQVUsSUFBSTtBQUFBLE1BQ3ZCO0FBQUEsSUFDRixDQUFDLENBQUM7QUFBQSxFQUNKO0FBR0EsUUFBTSxZQUFZLGlCQUFpQixjQUFjO0FBRWpELFFBQU0sZ0JBQWdCLGVBQWUsZUFBZSxTQUFTLENBQUMsRUFBRTtBQUdoRSxTQUFPO0FBQUEsSUFDTCxVQUFVLE9BQU8sZ0JBQWdCO0FBQUEsSUFDakM7QUFBQSxFQUNGO0FBR0EsUUFBTSxVQUFVLFlBQVksS0FBSyxPQUFPLEdBQUcsNkJBQTZCLENBQUM7QUFDekUsWUFBVSxLQUFLLFNBQVMsTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDcEQsTUFBSTtBQUNGLGlCQUFhO0FBQ2I7QUFBQSxNQUNFLEtBQUssU0FBUyxRQUFRLGNBQWM7QUFBQSxNQUNwQyxLQUFLLFVBQVUsRUFBRSxTQUFTLEdBQUcsa0JBQWtCLE9BQWUsT0FBTyxlQUFlLEdBQUcsTUFBTSxDQUFDO0FBQUEsSUFDaEc7QUFDQSxnQkFBWSxPQUFPO0FBQ25CLFVBQU0sU0FBUyxVQUFVO0FBQ3pCLFVBQU0sZ0JBQWdCLGlCQUFpQixPQUFPLEtBQUs7QUFDbkQsV0FBTyxNQUFNLE9BQU8sTUFBTSxRQUFRLEdBQUcsMENBQTBDO0FBQy9FLFdBQU87QUFBQSxNQUNMLGNBQWM7QUFBQSxNQUFNO0FBQUEsTUFDcEIsMEJBQTBCLGFBQWEsU0FBUyxjQUFjLElBQUk7QUFBQSxJQUNwRTtBQUFBLEVBQ0YsVUFBRTtBQUNBLGlCQUFhO0FBQ2IsV0FBTyxTQUFTLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDbEQ7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
