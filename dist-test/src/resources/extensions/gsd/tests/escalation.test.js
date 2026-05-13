import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getTask,
  claimEscalationOverride,
  findUnappliedEscalationOverride,
  listEscalationArtifacts,
  SCHEMA_VERSION,
  _getAdapter
} from "../gsd-db.js";
import {
  buildEscalationArtifact,
  writeEscalationArtifact,
  readEscalationArtifact,
  detectPendingEscalation,
  resolveEscalation,
  claimOverrideForInjection,
  escalationArtifactPath
} from "../escalation.js";
function makeBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr011-p2-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}
function cleanup(base) {
  try {
    closeDatabase();
  } catch {
  }
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
  }
}
function writePrefs(base, enabled) {
  const path = join(base, ".gsd", "PREFERENCES.md");
  writeFileSync(path, [
    "---",
    "version: 1",
    "phases:",
    `  mid_execution_escalation: ${enabled}`,
    "---"
  ].join("\n"));
}
function seedCompletedTask(base, taskId) {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice" });
  insertTask({
    id: taskId,
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task",
    status: "complete"
  });
}
const sampleOptions = [
  { id: "A", label: "Separate table", tradeoffs: "More flexible; requires migration." },
  { id: "B", label: "JSON array", tradeoffs: "Simpler; limited to ~1000 entries." }
];
test("ADR-011 P2: writeEscalationArtifact persists canonical JSON at tasks/T##-ESCALATION.json", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T03");
  const art = buildEscalationArtifact({
    taskId: "T03",
    sliceId: "S01",
    milestoneId: "M001",
    question: "Where should we store notifications?",
    options: sampleOptions,
    recommendation: "B",
    recommendationRationale: "Single-user display only.",
    continueWithDefault: false
  });
  const path = writeEscalationArtifact(base, art);
  assert.ok(existsSync(path), "artifact file must exist");
  assert.ok(path.endsWith("/tasks/T03-ESCALATION.json"), `path should end with tasks/T03-ESCALATION.json, got ${path}`);
  const roundTrip = readEscalationArtifact(path);
  assert.ok(roundTrip, "artifact must round-trip");
  assert.equal(roundTrip.taskId, "T03");
  assert.equal(roundTrip.recommendation, "B");
  assert.equal(roundTrip.options.length, 2);
  const row = getTask("M001", "S01", "T03");
  assert.equal(row?.escalation_pending, 1);
  assert.equal(row?.escalation_awaiting_review, 0);
  assert.equal(row?.escalation_artifact_path, path);
});
test("ADR-011 P2: continueWithDefault=true sets awaiting_review (NOT pending) \u2014 no pause", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T04");
  const art = buildEscalationArtifact({
    taskId: "T04",
    sliceId: "S01",
    milestoneId: "M001",
    question: "Q",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "r",
    continueWithDefault: true
  });
  writeEscalationArtifact(base, art);
  const row = getTask("M001", "S01", "T04");
  assert.equal(row?.escalation_pending, 0, "fire-and-correct must NOT set escalation_pending");
  assert.equal(row?.escalation_awaiting_review, 1);
});
test("ADR-011 P2: detectPendingEscalation returns only pause-scoped escalations", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T01");
  seedCompletedTask(base, "T02");
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    question: "Q1",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "r",
    continueWithDefault: true
  }));
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T02",
    sliceId: "S01",
    milestoneId: "M001",
    question: "Q2",
    options: sampleOptions,
    recommendation: "B",
    recommendationRationale: "r",
    continueWithDefault: false
  }));
  const tasks = [getTask("M001", "S01", "T01"), getTask("M001", "S01", "T02")];
  const id = detectPendingEscalation(tasks, base);
  assert.equal(id, "T02", "only T02 is pause-worthy; T01 is awaiting_review");
});
test("ADR-011 P2: resolveEscalation(accept) marks artifact + clears flags", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T05");
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T05",
    sliceId: "S01",
    milestoneId: "M001",
    question: "Q",
    options: sampleOptions,
    recommendation: "B",
    recommendationRationale: "r",
    continueWithDefault: false
  }));
  const result = resolveEscalation(base, "M001", "S01", "T05", "accept", "looks good");
  assert.equal(result.status, "resolved");
  assert.equal(result.chosenOption?.id, "B");
  const row = getTask("M001", "S01", "T05");
  assert.equal(row?.escalation_pending, 0);
  assert.equal(row?.escalation_awaiting_review, 0);
  const artPath = escalationArtifactPath(base, "M001", "S01", "T05");
  const art = readEscalationArtifact(artPath);
  assert.ok(art?.respondedAt, "artifact must record respondedAt");
  assert.equal(art?.userChoice, "accept");
  assert.equal(art?.userRationale, "looks good");
});
test("ADR-011 P2: resolveEscalation(reject-blocker) sets blocker_discovered + blocker_source", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T06");
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T06",
    sliceId: "S01",
    milestoneId: "M001",
    question: "Q",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "r",
    continueWithDefault: false
  }));
  const result = resolveEscalation(base, "M001", "S01", "T06", "reject-blocker", "none of these work");
  assert.equal(result.status, "rejected-to-blocker");
  const row = getTask("M001", "S01", "T06");
  assert.equal(row?.blocker_discovered, true, "reject-blocker must flip blocker_discovered=1");
  assert.equal(row?.blocker_source, "reject-escalation", "blocker_source must record provenance");
  assert.equal(row?.escalation_pending, 0);
});
test("ADR-011 P2: resolveEscalation(invalid-choice) returns error + leaves state untouched", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T07");
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T07",
    sliceId: "S01",
    milestoneId: "M001",
    question: "Q",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "r",
    continueWithDefault: false
  }));
  const result = resolveEscalation(base, "M001", "S01", "T07", "Z", "");
  assert.equal(result.status, "invalid-choice");
  const row = getTask("M001", "S01", "T07");
  assert.equal(row?.escalation_pending, 1, "flag must still be pending after invalid choice");
});
test("ADR-011 P2: claimEscalationOverride is atomic \u2014 only one claimer wins the race", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T08");
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T08",
    sliceId: "S01",
    milestoneId: "M001",
    question: "Q",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "r",
    continueWithDefault: false
  }));
  resolveEscalation(base, "M001", "S01", "T08", "A", "pick A");
  const first = claimEscalationOverride("M001", "S01", "T08");
  const second = claimEscalationOverride("M001", "S01", "T08");
  assert.equal(first, true, "first claim wins");
  assert.equal(second, false, "second claim must fail \u2014 override already applied");
});
test("ADR-011 P2: claimOverrideForInjection returns null when flag ON but no unapplied override", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T09");
  const claimed = claimOverrideForInjection(base, "M001", "S01");
  assert.equal(claimed, null);
});
test("ADR-011 P2: claim does NOT fire on unresolved awaiting_review \u2014 resolution is preserved until user responds", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T09a");
  seedCompletedTask(base, "T09b");
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T09a",
    sliceId: "S01",
    milestoneId: "M001",
    question: "Which DB?",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "r",
    continueWithDefault: true
  }));
  const premature = claimOverrideForInjection(base, "M001", "S01");
  assert.equal(premature, null, "awaiting_review without respondedAt must not be claimed");
  const midState = getTask("M001", "S01", "T09a");
  assert.equal(midState?.escalation_override_applied_at, null, "applied_at must still be null");
  resolveEscalation(base, "M001", "S01", "T09a", "B", "actually B is better");
  const claimed = claimOverrideForInjection(base, "M001", "S01");
  assert.ok(claimed, "after user resolution, the override must be injectable");
  assert.equal(claimed.sourceTaskId, "T09a");
  assert.match(claimed.injectionBlock, /Escalation Override/);
});
test("ADR-011 P2: claimOverrideForInjection returns markdown block once, then null", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T10");
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T10",
    sliceId: "S01",
    milestoneId: "M001",
    question: "Which storage?",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "r",
    continueWithDefault: false
  }));
  resolveEscalation(base, "M001", "S01", "T10", "A", "pick A");
  const first = claimOverrideForInjection(base, "M001", "S01");
  assert.ok(first, "first claim returns the override");
  assert.match(first.injectionBlock, /Escalation Override/);
  assert.equal(first.sourceTaskId, "T10");
  const second = claimOverrideForInjection(base, "M001", "S01");
  assert.equal(second, null, "second call returns null (idempotent)");
});
test("ADR-011 P2: listEscalationArtifacts filters to actionable by default", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T11");
  seedCompletedTask(base, "T12");
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T11",
    sliceId: "S01",
    milestoneId: "M001",
    question: "Q",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "r",
    continueWithDefault: false
  }));
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T12",
    sliceId: "S01",
    milestoneId: "M001",
    question: "Q",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "r",
    continueWithDefault: false
  }));
  resolveEscalation(base, "M001", "S01", "T12", "A", "");
  const actionable = listEscalationArtifacts("M001", false);
  const all = listEscalationArtifacts("M001", true);
  assert.equal(actionable.length, 1, "only T11 is actionable");
  assert.equal(actionable[0].id, "T11");
  assert.equal(all.length, 2, "both surface with --all");
});
test("ADR-011 P2: schema v20 fresh DB has all escalation columns on tasks + source on decisions", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  const adapter = _getAdapter();
  const tasksCols = adapter.prepare("PRAGMA table_info(tasks)").all().map((r) => r["name"]);
  for (const col of [
    "blocker_source",
    "escalation_pending",
    "escalation_awaiting_review",
    "escalation_artifact_path",
    "escalation_override_applied_at"
  ]) {
    assert.ok(tasksCols.includes(col), `tasks table must have ${col} column`);
  }
  const decCols = adapter.prepare("PRAGMA table_info(decisions)").all().map((r) => r["name"]);
  assert.ok(decCols.includes("source"), "decisions table must have source column");
  const version = adapter.prepare("SELECT MAX(version) as v FROM schema_version").get();
  assert.equal(version?.["v"], SCHEMA_VERSION);
});
test("ADR-011 P2: findUnappliedEscalationOverride returns null when escalation_pending=1 (still pending)", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T13");
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T13",
    sliceId: "S01",
    milestoneId: "M001",
    question: "Q",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "r",
    continueWithDefault: false
  }));
  const found = findUnappliedEscalationOverride("M001", "S01");
  assert.equal(found, null, "pending escalation must not surface as unapplied override");
});
test("ADR-011 P3: concurrent escalations queue in arrival order \u2014 list returns multiple", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T20");
  seedCompletedTask(base, "T21");
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T20",
    sliceId: "S01",
    milestoneId: "M001",
    question: "Q1",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "r",
    continueWithDefault: false
  }));
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T21",
    sliceId: "S01",
    milestoneId: "M001",
    question: "Q2",
    options: sampleOptions,
    recommendation: "B",
    recommendationRationale: "r",
    continueWithDefault: false
  }));
  const pending = listEscalationArtifacts("M001", false);
  assert.equal(pending.length, 2);
  const first = detectPendingEscalation([getTask("M001", "S01", "T20"), getTask("M001", "S01", "T21")], base);
  assert.equal(first, "T20", "detection returns first pending in arrival order");
});
test("ADR-011 P3: recovery \u2014 malformed artifact returns null from read, does not crash", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T22");
  const artPath = escalationArtifactPath(base, "M001", "S01", "T22");
  mkdirSync(join(artPath, ".."), { recursive: true });
  writeFileSync(artPath, "{ this is not json");
  const result = readEscalationArtifact(artPath);
  assert.equal(result, null, "malformed JSON must return null (no throw)");
});
test("ADR-011 P3: resolve-on-missing-artifact returns not-found without partial state", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T23");
  const result = resolveEscalation(base, "M001", "S01", "T23", "A", "");
  assert.equal(result.status, "not-found");
  const row = getTask("M001", "S01", "T23");
  assert.equal(row?.escalation_pending, 0, "untouched");
});
test("ADR-011 P3: escalation write + detect latency \u2014 20 tasks, one escalation, detection under 100ms", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice" });
  for (let i = 1; i <= 20; i++) {
    const tid = `T${String(i).padStart(2, "0")}`;
    insertTask({ id: tid, sliceId: "S01", milestoneId: "M001", title: `Task ${i}`, status: "complete" });
  }
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T15",
    sliceId: "S01",
    milestoneId: "M001",
    question: "Q",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "r",
    continueWithDefault: false
  }));
  const tasks = Array.from({ length: 20 }, (_, i) => getTask("M001", "S01", `T${String(i + 1).padStart(2, "0")}`));
  const start = Date.now();
  const found = detectPendingEscalation(tasks, base);
  const elapsed = Date.now() - start;
  assert.equal(found, "T15");
  assert.ok(elapsed < 100, `detection must complete under 100ms, took ${elapsed}ms`);
});
test("ADR-011 P3 #20: E2E escalation lifecycle \u2014 write \u2192 pause \u2192 resolve \u2192 resume via override injection", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T30");
  seedCompletedTask(base, "T31");
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T30",
    sliceId: "S01",
    milestoneId: "M001",
    question: "Storage format for the new metrics table?",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "A is simpler",
    continueWithDefault: false
  }));
  let tasks = [getTask("M001", "S01", "T30"), getTask("M001", "S01", "T31")];
  assert.equal(
    detectPendingEscalation(tasks, base),
    "T30",
    "scheduler must pause on T30 before dispatching T31"
  );
  assert.equal(
    claimOverrideForInjection(base, "M001", "S01"),
    null,
    "no injection should fire while escalation is still pending"
  );
  const result = resolveEscalation(base, "M001", "S01", "T30", "B", "B fits better");
  assert.equal(result.status, "resolved");
  assert.equal(result.chosenOption?.id, "B");
  tasks = [getTask("M001", "S01", "T30"), getTask("M001", "S01", "T31")];
  assert.equal(
    detectPendingEscalation(tasks, base),
    null,
    "after resolve, scheduler must not re-pause on T30"
  );
  const injected = claimOverrideForInjection(base, "M001", "S01");
  assert.ok(injected, "T31's prompt build must claim the resolved override");
  assert.equal(injected.sourceTaskId, "T30");
  assert.match(injected.injectionBlock, /Escalation Override/);
  assert.match(injected.injectionBlock, /B/, "injection must reflect user's chosen option id");
  const secondClaim = claimOverrideForInjection(base, "M001", "S01");
  assert.equal(secondClaim, null, "override must be consumed exactly once");
});
test("ADR-011 P3 #21: blocker takes priority over escalation when both flags coexist on same task", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T40");
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T40",
    sliceId: "S01",
    milestoneId: "M001",
    question: "Which storage?",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "r",
    continueWithDefault: false
  }));
  let row = getTask("M001", "S01", "T40");
  assert.equal(row?.escalation_pending, 1);
  assert.equal(row?.blocker_discovered, false);
  assert.equal(detectPendingEscalation([row], base), "T40");
  const result = resolveEscalation(
    base,
    "M001",
    "S01",
    "T40",
    "reject-blocker",
    "none of these fit the observed constraints"
  );
  assert.equal(result.status, "rejected-to-blocker");
  row = getTask("M001", "S01", "T40");
  assert.equal(row?.blocker_discovered, true, "blocker_discovered must be set after reject-blocker");
  assert.equal(row?.blocker_source, "reject-escalation", "blocker_source records provenance");
  assert.equal(row?.escalation_pending, 0, "escalation_pending must be cleared");
  assert.equal(row?.escalation_awaiting_review, 0, "escalation_awaiting_review must be cleared");
  assert.equal(
    detectPendingEscalation([row], base),
    null,
    "after reject-blocker, escalation must not pause \u2014 blocker path owns the task"
  );
});
test("ADR-011 P3 #22: ADR-009 audit envelopes emitted across the escalation lifecycle", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T50");
  seedCompletedTask(base, "T51");
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T50",
    sliceId: "S01",
    milestoneId: "M001",
    question: "Q50",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "r",
    continueWithDefault: false
  }));
  resolveEscalation(base, "M001", "S01", "T50", "accept", "sounds right");
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T51",
    sliceId: "S01",
    milestoneId: "M001",
    question: "Q51",
    options: sampleOptions,
    recommendation: "B",
    recommendationRationale: "r",
    continueWithDefault: false
  }));
  resolveEscalation(base, "M001", "S01", "T51", "reject-blocker", "blocker path");
  const logPath = join(base, ".gsd", "audit", "events.jsonl");
  assert.ok(existsSync(logPath), "audit log must exist at .gsd/audit/events.jsonl");
  const lines = readFileSync(logPath, "utf-8").split("\n").filter((l) => l.length > 0);
  const events = lines.map((l) => JSON.parse(l));
  const escalationEvents = events.filter((e) => typeof e["type"] === "string" && e["type"].startsWith("escalation-"));
  const types = escalationEvents.map((e) => e["type"]).sort();
  assert.deepEqual(types, [
    "escalation-manual-attention-created",
    "escalation-manual-attention-created",
    "escalation-rejected-to-blocker",
    "escalation-user-responded"
  ]);
  for (const env of escalationEvents) {
    assert.equal(typeof env["eventId"], "string", "envelope must include eventId");
    assert.equal(typeof env["traceId"], "string", "envelope must include traceId");
    assert.match(env["traceId"], /^escalation:M001:S01:T5[01]$/, "traceId must be stable and task-scoped");
    assert.equal(env["category"], "gate", "escalation events belong to the gate control plane");
    assert.equal(typeof env["ts"], "string");
    assert.ok(env["payload"] && typeof env["payload"] === "object", "payload must be an object");
    const payload = env["payload"];
    assert.equal(payload["milestoneId"], "M001");
    assert.equal(payload["sliceId"], "S01");
    assert.ok(payload["taskId"] === "T50" || payload["taskId"] === "T51");
  }
});
test("ADR-011 P3 #23: concurrent escalations across parallel slices \u2014 only the escalating branch pauses", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice A" });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Slice B" });
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S02", "tasks"), { recursive: true });
  insertTask({ id: "T60", sliceId: "S01", milestoneId: "M001", title: "Task A", status: "complete" });
  insertTask({ id: "T70", sliceId: "S02", milestoneId: "M001", title: "Task B", status: "complete" });
  insertTask({ id: "T71", sliceId: "S02", milestoneId: "M001", title: "Task B2", status: "complete" });
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T60",
    sliceId: "S01",
    milestoneId: "M001",
    question: "S01 ambiguity?",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "r",
    continueWithDefault: false
  }));
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T70",
    sliceId: "S02",
    milestoneId: "M001",
    question: "S02 ambiguity?",
    options: sampleOptions,
    recommendation: "B",
    recommendationRationale: "r",
    continueWithDefault: false
  }));
  const s01Tasks = [getTask("M001", "S01", "T60")];
  const s02Tasks = [getTask("M001", "S02", "T70"), getTask("M001", "S02", "T71")];
  assert.equal(detectPendingEscalation(s01Tasks, base), "T60");
  assert.equal(detectPendingEscalation(s02Tasks, base), "T70");
  resolveEscalation(base, "M001", "S01", "T60", "A", "pick A");
  assert.equal(detectPendingEscalation([getTask("M001", "S01", "T60")], base), null);
  assert.equal(
    detectPendingEscalation([getTask("M001", "S02", "T70"), getTask("M001", "S02", "T71")], base),
    "T70",
    "resolving one slice's escalation must leave the other slice paused"
  );
  resolveEscalation(base, "M001", "S02", "T70", "B", "pick B");
  assert.equal(detectPendingEscalation([getTask("M001", "S02", "T70")], base), null);
});
test("ADR-011 P3 #24: continueWithDefault timeout \u2014 late user response injects into the next task dispatched AFTER the response", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T80");
  seedCompletedTask(base, "T81");
  seedCompletedTask(base, "T82");
  seedCompletedTask(base, "T83");
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T80",
    sliceId: "S01",
    milestoneId: "M001",
    question: "Which cache strategy?",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "A matches current telemetry",
    continueWithDefault: true
  }));
  assert.equal(getTask("M001", "S01", "T80")?.escalation_awaiting_review, 1);
  assert.equal(getTask("M001", "S01", "T80")?.escalation_pending, 0);
  assert.equal(detectPendingEscalation([getTask("M001", "S01", "T80")], base), null);
  assert.equal(
    claimOverrideForInjection(base, "M001", "S01"),
    null,
    "T81's prompt build must not claim the unresolved awaiting_review"
  );
  assert.equal(
    claimOverrideForInjection(base, "M001", "S01"),
    null,
    "T82's prompt build must also not claim the unresolved awaiting_review"
  );
  assert.equal(
    getTask("M001", "S01", "T80")?.escalation_override_applied_at,
    null,
    "applied_at must stay null throughout the response window"
  );
  const resolveResult = resolveEscalation(
    base,
    "M001",
    "S01",
    "T80",
    "B",
    "after reviewing, B is the call"
  );
  assert.equal(resolveResult.status, "resolved");
  assert.equal(resolveResult.chosenOption?.id, "B");
  const claimed = claimOverrideForInjection(base, "M001", "S01");
  assert.ok(claimed, "T83's prompt build must claim the late-resolved override");
  assert.equal(claimed.sourceTaskId, "T80");
  assert.match(claimed.injectionBlock, /Escalation Override/);
  assert.match(
    claimed.injectionBlock,
    /JSON array|B/,
    "injection must reflect the user's B choice, NOT the original A recommendation"
  );
  assert.equal(claimOverrideForInjection(base, "M001", "S01"), null);
});
test("ADR-011 P3 #25: artifact write failure surfaces, leaves DB flags clean, and retries successfully once recovered", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S09", milestoneId: "M001", title: "Unseeded slice" });
  insertTask({ id: "T90", sliceId: "S09", milestoneId: "M001", title: "T", status: "complete" });
  const artifact = buildEscalationArtifact({
    taskId: "T90",
    sliceId: "S09",
    milestoneId: "M001",
    question: "Q",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "r",
    continueWithDefault: false
  });
  assert.throws(
    () => writeEscalationArtifact(base, artifact),
    /cannot resolve tasks dir/,
    "missing slice dir must raise \u2014 caller is expected to run doctor before retry"
  );
  const midRow = getTask("M001", "S09", "T90");
  assert.equal(midRow?.escalation_pending, 0, "failed write must leave escalation_pending=0");
  assert.equal(midRow?.escalation_awaiting_review, 0);
  assert.equal(midRow?.escalation_artifact_path, null);
  const logPath = join(base, ".gsd", "audit", "events.jsonl");
  const preLines = existsSync(logPath) ? readFileSync(logPath, "utf-8").split("\n").filter((l) => l.length > 0) : [];
  const preCount = preLines.filter((l) => l.includes("escalation-manual-attention-created")).length;
  assert.equal(preCount, 0, "failed write must not emit an audit envelope");
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S09", "tasks"), { recursive: true });
  const { clearPathCache } = await import("../paths.js");
  clearPathCache();
  const path = writeEscalationArtifact(base, artifact);
  assert.ok(existsSync(path), "retry must atomically land the artifact on disk");
  const afterRow = getTask("M001", "S09", "T90");
  assert.equal(afterRow?.escalation_pending, 1, "successful retry must flip escalation_pending=1");
  assert.equal(afterRow?.escalation_artifact_path, path);
  const postLines = readFileSync(logPath, "utf-8").split("\n").filter((l) => l.length > 0);
  const t90Events = postLines.map((l) => JSON.parse(l)).filter(
    (e) => e["type"] === "escalation-manual-attention-created" && e["payload"]?.["taskId"] === "T90"
  );
  assert.equal(t90Events.length, 1, "successful retry must emit exactly one audit envelope");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9lc2NhbGF0aW9uLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRCBFeHRlbnNpb24gXHUyMDE0IEFEUi0wMTEgUGhhc2UgMiBNaWQtRXhlY3V0aW9uIEVzY2FsYXRpb24gdGVzdHNcbi8vIENvdmVyczogYXJ0aWZhY3Qgd3JpdGUvcmVhZCwgZGV0ZWN0aW9uLCByZXNvbHV0aW9uIChBfEJ8YWNjZXB0fHJlamVjdC1ibG9ja2VyKSxcbi8vIERCIGNsYWltIHJhY2UsIGNhcnJ5LWZvcndhcmQgaW5qZWN0aW9uLCBzY2hlbWEgdjE2L3YxNyBtaWdyYXRpb24sIGZlYXR1cmUgZmxhZy5cblxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMsIGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHtcbiAgb3BlbkRhdGFiYXNlLFxuICBjbG9zZURhdGFiYXNlLFxuICBpbnNlcnRNaWxlc3RvbmUsXG4gIGluc2VydFNsaWNlLFxuICBpbnNlcnRUYXNrLFxuICB1cGRhdGVUYXNrU3RhdHVzLFxuICBnZXRUYXNrLFxuICBjbGFpbUVzY2FsYXRpb25PdmVycmlkZSxcbiAgZmluZFVuYXBwbGllZEVzY2FsYXRpb25PdmVycmlkZSxcbiAgbGlzdEVzY2FsYXRpb25BcnRpZmFjdHMsXG4gIFNDSEVNQV9WRVJTSU9OLFxuICBfZ2V0QWRhcHRlcixcbn0gZnJvbSBcIi4uL2dzZC1kYi50c1wiO1xuaW1wb3J0IHtcbiAgYnVpbGRFc2NhbGF0aW9uQXJ0aWZhY3QsXG4gIHdyaXRlRXNjYWxhdGlvbkFydGlmYWN0LFxuICByZWFkRXNjYWxhdGlvbkFydGlmYWN0LFxuICBkZXRlY3RQZW5kaW5nRXNjYWxhdGlvbixcbiAgcmVzb2x2ZUVzY2FsYXRpb24sXG4gIGNsYWltT3ZlcnJpZGVGb3JJbmplY3Rpb24sXG4gIGVzY2FsYXRpb25BcnRpZmFjdFBhdGgsXG59IGZyb20gXCIuLi9lc2NhbGF0aW9uLnRzXCI7XG5pbXBvcnQgdHlwZSB7IEVzY2FsYXRpb25PcHRpb24gfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEZpeHR1cmUgaGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gbWFrZUJhc2UoKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWFkcjAxMS1wMi1cIikpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiLCBcInRhc2tzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIHRyeSB7IGNsb3NlRGF0YWJhc2UoKTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfVxuICB0cnkgeyBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9XG59XG5cbmZ1bmN0aW9uIHdyaXRlUHJlZnMoYmFzZTogc3RyaW5nLCBlbmFibGVkOiBib29sZWFuKTogdm9pZCB7XG4gIGNvbnN0IHBhdGggPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpO1xuICB3cml0ZUZpbGVTeW5jKHBhdGgsIFtcbiAgICBcIi0tLVwiLFxuICAgIFwidmVyc2lvbjogMVwiLFxuICAgIFwicGhhc2VzOlwiLFxuICAgIGAgIG1pZF9leGVjdXRpb25fZXNjYWxhdGlvbjogJHtlbmFibGVkfWAsXG4gICAgXCItLS1cIixcbiAgXS5qb2luKFwiXFxuXCIpKTtcbn1cblxuZnVuY3Rpb24gc2VlZENvbXBsZXRlZFRhc2soYmFzZTogc3RyaW5nLCB0YXNrSWQ6IHN0cmluZyk6IHZvaWQge1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlNsaWNlXCIgfSk7XG4gIGluc2VydFRhc2soe1xuICAgIGlkOiB0YXNrSWQsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGFza1wiLFxuICAgIHN0YXR1czogXCJjb21wbGV0ZVwiLFxuICB9KTtcbn1cblxuY29uc3Qgc2FtcGxlT3B0aW9uczogRXNjYWxhdGlvbk9wdGlvbltdID0gW1xuICB7IGlkOiBcIkFcIiwgbGFiZWw6IFwiU2VwYXJhdGUgdGFibGVcIiwgdHJhZGVvZmZzOiBcIk1vcmUgZmxleGlibGU7IHJlcXVpcmVzIG1pZ3JhdGlvbi5cIiB9LFxuICB7IGlkOiBcIkJcIiwgbGFiZWw6IFwiSlNPTiBhcnJheVwiLCB0cmFkZW9mZnM6IFwiU2ltcGxlcjsgbGltaXRlZCB0byB+MTAwMCBlbnRyaWVzLlwiIH0sXG5dO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIFRlc3RzXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxudGVzdChcIkFEUi0wMTEgUDI6IHdyaXRlRXNjYWxhdGlvbkFydGlmYWN0IHBlcnNpc3RzIGNhbm9uaWNhbCBKU09OIGF0IHRhc2tzL1QjIy1FU0NBTEFUSU9OLmpzb25cIiwgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChiYXNlKSk7XG4gIHNlZWRDb21wbGV0ZWRUYXNrKGJhc2UsIFwiVDAzXCIpO1xuXG4gIGNvbnN0IGFydCA9IGJ1aWxkRXNjYWxhdGlvbkFydGlmYWN0KHtcbiAgICB0YXNrSWQ6IFwiVDAzXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICBxdWVzdGlvbjogXCJXaGVyZSBzaG91bGQgd2Ugc3RvcmUgbm90aWZpY2F0aW9ucz9cIixcbiAgICBvcHRpb25zOiBzYW1wbGVPcHRpb25zLFxuICAgIHJlY29tbWVuZGF0aW9uOiBcIkJcIixcbiAgICByZWNvbW1lbmRhdGlvblJhdGlvbmFsZTogXCJTaW5nbGUtdXNlciBkaXNwbGF5IG9ubHkuXCIsXG4gICAgY29udGludWVXaXRoRGVmYXVsdDogZmFsc2UsXG4gIH0pO1xuICBjb25zdCBwYXRoID0gd3JpdGVFc2NhbGF0aW9uQXJ0aWZhY3QoYmFzZSwgYXJ0KTtcbiAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMocGF0aCksIFwiYXJ0aWZhY3QgZmlsZSBtdXN0IGV4aXN0XCIpO1xuICBhc3NlcnQub2socGF0aC5lbmRzV2l0aChcIi90YXNrcy9UMDMtRVNDQUxBVElPTi5qc29uXCIpLCBgcGF0aCBzaG91bGQgZW5kIHdpdGggdGFza3MvVDAzLUVTQ0FMQVRJT04uanNvbiwgZ290ICR7cGF0aH1gKTtcblxuICBjb25zdCByb3VuZFRyaXAgPSByZWFkRXNjYWxhdGlvbkFydGlmYWN0KHBhdGgpO1xuICBhc3NlcnQub2socm91bmRUcmlwLCBcImFydGlmYWN0IG11c3Qgcm91bmQtdHJpcFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJvdW5kVHJpcCEudGFza0lkLCBcIlQwM1wiKTtcbiAgYXNzZXJ0LmVxdWFsKHJvdW5kVHJpcCEucmVjb21tZW5kYXRpb24sIFwiQlwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJvdW5kVHJpcCEub3B0aW9ucy5sZW5ndGgsIDIpO1xuXG4gIC8vIERCIGZsYWcgZmxpcHBlZCB0byBwZW5kaW5nIChjb250aW51ZVdpdGhEZWZhdWx0PWZhbHNlKS5cbiAgY29uc3Qgcm93ID0gZ2V0VGFzayhcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMDNcIik7XG4gIGFzc2VydC5lcXVhbChyb3c/LmVzY2FsYXRpb25fcGVuZGluZywgMSk7XG4gIGFzc2VydC5lcXVhbChyb3c/LmVzY2FsYXRpb25fYXdhaXRpbmdfcmV2aWV3LCAwKTtcbiAgYXNzZXJ0LmVxdWFsKHJvdz8uZXNjYWxhdGlvbl9hcnRpZmFjdF9wYXRoLCBwYXRoKTtcbn0pO1xuXG50ZXN0KFwiQURSLTAxMSBQMjogY29udGludWVXaXRoRGVmYXVsdD10cnVlIHNldHMgYXdhaXRpbmdfcmV2aWV3IChOT1QgcGVuZGluZykgXHUyMDE0IG5vIHBhdXNlXCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuICBzZWVkQ29tcGxldGVkVGFzayhiYXNlLCBcIlQwNFwiKTtcblxuICBjb25zdCBhcnQgPSBidWlsZEVzY2FsYXRpb25BcnRpZmFjdCh7XG4gICAgdGFza0lkOiBcIlQwNFwiLCBzbGljZUlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgcXVlc3Rpb246IFwiUVwiLFxuICAgIG9wdGlvbnM6IHNhbXBsZU9wdGlvbnMsXG4gICAgcmVjb21tZW5kYXRpb246IFwiQVwiLFxuICAgIHJlY29tbWVuZGF0aW9uUmF0aW9uYWxlOiBcInJcIixcbiAgICBjb250aW51ZVdpdGhEZWZhdWx0OiB0cnVlLFxuICB9KTtcbiAgd3JpdGVFc2NhbGF0aW9uQXJ0aWZhY3QoYmFzZSwgYXJ0KTtcblxuICBjb25zdCByb3cgPSBnZXRUYXNrKFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQwNFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJvdz8uZXNjYWxhdGlvbl9wZW5kaW5nLCAwLCBcImZpcmUtYW5kLWNvcnJlY3QgbXVzdCBOT1Qgc2V0IGVzY2FsYXRpb25fcGVuZGluZ1wiKTtcbiAgYXNzZXJ0LmVxdWFsKHJvdz8uZXNjYWxhdGlvbl9hd2FpdGluZ19yZXZpZXcsIDEpO1xufSk7XG5cbnRlc3QoXCJBRFItMDExIFAyOiBkZXRlY3RQZW5kaW5nRXNjYWxhdGlvbiByZXR1cm5zIG9ubHkgcGF1c2Utc2NvcGVkIGVzY2FsYXRpb25zXCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuICBzZWVkQ29tcGxldGVkVGFzayhiYXNlLCBcIlQwMVwiKTtcbiAgc2VlZENvbXBsZXRlZFRhc2soYmFzZSwgXCJUMDJcIik7XG5cbiAgLy8gVDAxOiBjb250aW51ZVdpdGhEZWZhdWx0PXRydWUgKGF3YWl0aW5nX3Jldmlldywgbm90IHBlbmRpbmcpXG4gIHdyaXRlRXNjYWxhdGlvbkFydGlmYWN0KGJhc2UsIGJ1aWxkRXNjYWxhdGlvbkFydGlmYWN0KHtcbiAgICB0YXNrSWQ6IFwiVDAxXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICBxdWVzdGlvbjogXCJRMVwiLCBvcHRpb25zOiBzYW1wbGVPcHRpb25zLCByZWNvbW1lbmRhdGlvbjogXCJBXCIsIHJlY29tbWVuZGF0aW9uUmF0aW9uYWxlOiBcInJcIixcbiAgICBjb250aW51ZVdpdGhEZWZhdWx0OiB0cnVlLFxuICB9KSk7XG4gIC8vIFQwMjogY29udGludWVXaXRoRGVmYXVsdD1mYWxzZSAocGF1c2UpXG4gIHdyaXRlRXNjYWxhdGlvbkFydGlmYWN0KGJhc2UsIGJ1aWxkRXNjYWxhdGlvbkFydGlmYWN0KHtcbiAgICB0YXNrSWQ6IFwiVDAyXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICBxdWVzdGlvbjogXCJRMlwiLCBvcHRpb25zOiBzYW1wbGVPcHRpb25zLCByZWNvbW1lbmRhdGlvbjogXCJCXCIsIHJlY29tbWVuZGF0aW9uUmF0aW9uYWxlOiBcInJcIixcbiAgICBjb250aW51ZVdpdGhEZWZhdWx0OiBmYWxzZSxcbiAgfSkpO1xuXG4gIGNvbnN0IHRhc2tzID0gW2dldFRhc2soXCJNMDAxXCIsIFwiUzAxXCIsIFwiVDAxXCIpISwgZ2V0VGFzayhcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMDJcIikhXTtcbiAgY29uc3QgaWQgPSBkZXRlY3RQZW5kaW5nRXNjYWxhdGlvbih0YXNrcywgYmFzZSk7XG4gIGFzc2VydC5lcXVhbChpZCwgXCJUMDJcIiwgXCJvbmx5IFQwMiBpcyBwYXVzZS13b3J0aHk7IFQwMSBpcyBhd2FpdGluZ19yZXZpZXdcIik7XG59KTtcblxudGVzdChcIkFEUi0wMTEgUDI6IHJlc29sdmVFc2NhbGF0aW9uKGFjY2VwdCkgbWFya3MgYXJ0aWZhY3QgKyBjbGVhcnMgZmxhZ3NcIiwgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChiYXNlKSk7XG4gIHNlZWRDb21wbGV0ZWRUYXNrKGJhc2UsIFwiVDA1XCIpO1xuXG4gIHdyaXRlRXNjYWxhdGlvbkFydGlmYWN0KGJhc2UsIGJ1aWxkRXNjYWxhdGlvbkFydGlmYWN0KHtcbiAgICB0YXNrSWQ6IFwiVDA1XCIsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICBxdWVzdGlvbjogXCJRXCIsIG9wdGlvbnM6IHNhbXBsZU9wdGlvbnMsIHJlY29tbWVuZGF0aW9uOiBcIkJcIiwgcmVjb21tZW5kYXRpb25SYXRpb25hbGU6IFwiclwiLFxuICAgIGNvbnRpbnVlV2l0aERlZmF1bHQ6IGZhbHNlLFxuICB9KSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZUVzY2FsYXRpb24oYmFzZSwgXCJNMDAxXCIsIFwiUzAxXCIsIFwiVDA1XCIsIFwiYWNjZXB0XCIsIFwibG9va3MgZ29vZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGF0dXMsIFwicmVzb2x2ZWRcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuY2hvc2VuT3B0aW9uPy5pZCwgXCJCXCIpO1xuXG4gIGNvbnN0IHJvdyA9IGdldFRhc2soXCJNMDAxXCIsIFwiUzAxXCIsIFwiVDA1XCIpO1xuICBhc3NlcnQuZXF1YWwocm93Py5lc2NhbGF0aW9uX3BlbmRpbmcsIDApO1xuICBhc3NlcnQuZXF1YWwocm93Py5lc2NhbGF0aW9uX2F3YWl0aW5nX3JldmlldywgMCk7XG5cbiAgY29uc3QgYXJ0UGF0aCA9IGVzY2FsYXRpb25BcnRpZmFjdFBhdGgoYmFzZSwgXCJNMDAxXCIsIFwiUzAxXCIsIFwiVDA1XCIpITtcbiAgY29uc3QgYXJ0ID0gcmVhZEVzY2FsYXRpb25BcnRpZmFjdChhcnRQYXRoKTtcbiAgYXNzZXJ0Lm9rKGFydD8ucmVzcG9uZGVkQXQsIFwiYXJ0aWZhY3QgbXVzdCByZWNvcmQgcmVzcG9uZGVkQXRcIik7XG4gIGFzc2VydC5lcXVhbChhcnQ/LnVzZXJDaG9pY2UsIFwiYWNjZXB0XCIpO1xuICBhc3NlcnQuZXF1YWwoYXJ0Py51c2VyUmF0aW9uYWxlLCBcImxvb2tzIGdvb2RcIik7XG59KTtcblxudGVzdChcIkFEUi0wMTEgUDI6IHJlc29sdmVFc2NhbGF0aW9uKHJlamVjdC1ibG9ja2VyKSBzZXRzIGJsb2NrZXJfZGlzY292ZXJlZCArIGJsb2NrZXJfc291cmNlXCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuICBzZWVkQ29tcGxldGVkVGFzayhiYXNlLCBcIlQwNlwiKTtcblxuICB3cml0ZUVzY2FsYXRpb25BcnRpZmFjdChiYXNlLCBidWlsZEVzY2FsYXRpb25BcnRpZmFjdCh7XG4gICAgdGFza0lkOiBcIlQwNlwiLCBzbGljZUlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgcXVlc3Rpb246IFwiUVwiLCBvcHRpb25zOiBzYW1wbGVPcHRpb25zLCByZWNvbW1lbmRhdGlvbjogXCJBXCIsIHJlY29tbWVuZGF0aW9uUmF0aW9uYWxlOiBcInJcIixcbiAgICBjb250aW51ZVdpdGhEZWZhdWx0OiBmYWxzZSxcbiAgfSkpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVFc2NhbGF0aW9uKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQwNlwiLCBcInJlamVjdC1ibG9ja2VyXCIsIFwibm9uZSBvZiB0aGVzZSB3b3JrXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXR1cywgXCJyZWplY3RlZC10by1ibG9ja2VyXCIpO1xuXG4gIGNvbnN0IHJvdyA9IGdldFRhc2soXCJNMDAxXCIsIFwiUzAxXCIsIFwiVDA2XCIpO1xuICBhc3NlcnQuZXF1YWwocm93Py5ibG9ja2VyX2Rpc2NvdmVyZWQsIHRydWUsIFwicmVqZWN0LWJsb2NrZXIgbXVzdCBmbGlwIGJsb2NrZXJfZGlzY292ZXJlZD0xXCIpO1xuICBhc3NlcnQuZXF1YWwocm93Py5ibG9ja2VyX3NvdXJjZSwgXCJyZWplY3QtZXNjYWxhdGlvblwiLCBcImJsb2NrZXJfc291cmNlIG11c3QgcmVjb3JkIHByb3ZlbmFuY2VcIik7XG4gIGFzc2VydC5lcXVhbChyb3c/LmVzY2FsYXRpb25fcGVuZGluZywgMCk7XG59KTtcblxudGVzdChcIkFEUi0wMTEgUDI6IHJlc29sdmVFc2NhbGF0aW9uKGludmFsaWQtY2hvaWNlKSByZXR1cm5zIGVycm9yICsgbGVhdmVzIHN0YXRlIHVudG91Y2hlZFwiLCAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGJhc2UpKTtcbiAgc2VlZENvbXBsZXRlZFRhc2soYmFzZSwgXCJUMDdcIik7XG5cbiAgd3JpdGVFc2NhbGF0aW9uQXJ0aWZhY3QoYmFzZSwgYnVpbGRFc2NhbGF0aW9uQXJ0aWZhY3Qoe1xuICAgIHRhc2tJZDogXCJUMDdcIiwgc2xpY2VJZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIHF1ZXN0aW9uOiBcIlFcIiwgb3B0aW9uczogc2FtcGxlT3B0aW9ucywgcmVjb21tZW5kYXRpb246IFwiQVwiLCByZWNvbW1lbmRhdGlvblJhdGlvbmFsZTogXCJyXCIsXG4gICAgY29udGludWVXaXRoRGVmYXVsdDogZmFsc2UsXG4gIH0pKTtcblxuICBjb25zdCByZXN1bHQgPSByZXNvbHZlRXNjYWxhdGlvbihiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMDdcIiwgXCJaXCIsIFwiXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXR1cywgXCJpbnZhbGlkLWNob2ljZVwiKTtcblxuICAvLyBTdGF0ZSBtdXN0IE5PVCBoYXZlIGNoYW5nZWQuXG4gIGNvbnN0IHJvdyA9IGdldFRhc2soXCJNMDAxXCIsIFwiUzAxXCIsIFwiVDA3XCIpO1xuICBhc3NlcnQuZXF1YWwocm93Py5lc2NhbGF0aW9uX3BlbmRpbmcsIDEsIFwiZmxhZyBtdXN0IHN0aWxsIGJlIHBlbmRpbmcgYWZ0ZXIgaW52YWxpZCBjaG9pY2VcIik7XG59KTtcblxudGVzdChcIkFEUi0wMTEgUDI6IGNsYWltRXNjYWxhdGlvbk92ZXJyaWRlIGlzIGF0b21pYyBcdTIwMTQgb25seSBvbmUgY2xhaW1lciB3aW5zIHRoZSByYWNlXCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuICBzZWVkQ29tcGxldGVkVGFzayhiYXNlLCBcIlQwOFwiKTtcblxuICB3cml0ZUVzY2FsYXRpb25BcnRpZmFjdChiYXNlLCBidWlsZEVzY2FsYXRpb25BcnRpZmFjdCh7XG4gICAgdGFza0lkOiBcIlQwOFwiLCBzbGljZUlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgcXVlc3Rpb246IFwiUVwiLCBvcHRpb25zOiBzYW1wbGVPcHRpb25zLCByZWNvbW1lbmRhdGlvbjogXCJBXCIsIHJlY29tbWVuZGF0aW9uUmF0aW9uYWxlOiBcInJcIixcbiAgICBjb250aW51ZVdpdGhEZWZhdWx0OiBmYWxzZSxcbiAgfSkpO1xuICByZXNvbHZlRXNjYWxhdGlvbihiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMDhcIiwgXCJBXCIsIFwicGljayBBXCIpO1xuXG4gIGNvbnN0IGZpcnN0ID0gY2xhaW1Fc2NhbGF0aW9uT3ZlcnJpZGUoXCJNMDAxXCIsIFwiUzAxXCIsIFwiVDA4XCIpO1xuICBjb25zdCBzZWNvbmQgPSBjbGFpbUVzY2FsYXRpb25PdmVycmlkZShcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMDhcIik7XG4gIGFzc2VydC5lcXVhbChmaXJzdCwgdHJ1ZSwgXCJmaXJzdCBjbGFpbSB3aW5zXCIpO1xuICBhc3NlcnQuZXF1YWwoc2Vjb25kLCBmYWxzZSwgXCJzZWNvbmQgY2xhaW0gbXVzdCBmYWlsIFx1MjAxNCBvdmVycmlkZSBhbHJlYWR5IGFwcGxpZWRcIik7XG59KTtcblxudGVzdChcIkFEUi0wMTEgUDI6IGNsYWltT3ZlcnJpZGVGb3JJbmplY3Rpb24gcmV0dXJucyBudWxsIHdoZW4gZmxhZyBPTiBidXQgbm8gdW5hcHBsaWVkIG92ZXJyaWRlXCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuICBzZWVkQ29tcGxldGVkVGFzayhiYXNlLCBcIlQwOVwiKTtcblxuICBjb25zdCBjbGFpbWVkID0gY2xhaW1PdmVycmlkZUZvckluamVjdGlvbihiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIik7XG4gIGFzc2VydC5lcXVhbChjbGFpbWVkLCBudWxsKTtcbn0pO1xuXG50ZXN0KFwiQURSLTAxMSBQMjogY2xhaW0gZG9lcyBOT1QgZmlyZSBvbiB1bnJlc29sdmVkIGF3YWl0aW5nX3JldmlldyBcdTIwMTQgcmVzb2x1dGlvbiBpcyBwcmVzZXJ2ZWQgdW50aWwgdXNlciByZXNwb25kc1wiLCAodCkgPT4ge1xuICAvLyBSZWdyZXNzaW9uIGZvciBwZWVyLXJldmlldyBCdWcgMjogcHJldmlvdXNseSBmaW5kVW5hcHBsaWVkRXNjYWxhdGlvbk92ZXJyaWRlXG4gIC8vIG1hdGNoZWQgYGVzY2FsYXRpb25fcGVuZGluZz0wYCBhbG9uZSwgc28gYW4gYXdhaXRpbmdfcmV2aWV3IHRhc2sgKGNyZWF0ZWRcbiAgLy8gYnkgY29udGludWVXaXRoRGVmYXVsdD10cnVlKSB3YXMgc2lsZW50bHkgY2xhaW1lZCBiZWZvcmUgdGhlIHVzZXIgaGFkXG4gIC8vIGEgY2hhbmNlIHRvIHJlc29sdmUsIHBlcm1hbmVudGx5IGRyb3BwaW5nIHRoZSBvdmVycmlkZS5cbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChiYXNlKSk7XG4gIHNlZWRDb21wbGV0ZWRUYXNrKGJhc2UsIFwiVDA5YVwiKTtcbiAgc2VlZENvbXBsZXRlZFRhc2soYmFzZSwgXCJUMDliXCIpO1xuXG4gIC8vIFdyaXRlIGEgY29udGludWVXaXRoRGVmYXVsdD10cnVlIGFydGlmYWN0IChhd2FpdGluZ19yZXZpZXc9MSwgbm8gcmVzcG9uZGVkQXQpLlxuICB3cml0ZUVzY2FsYXRpb25BcnRpZmFjdChiYXNlLCBidWlsZEVzY2FsYXRpb25BcnRpZmFjdCh7XG4gICAgdGFza0lkOiBcIlQwOWFcIiwgc2xpY2VJZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIHF1ZXN0aW9uOiBcIldoaWNoIERCP1wiLCBvcHRpb25zOiBzYW1wbGVPcHRpb25zLFxuICAgIHJlY29tbWVuZGF0aW9uOiBcIkFcIiwgcmVjb21tZW5kYXRpb25SYXRpb25hbGU6IFwiclwiLFxuICAgIGNvbnRpbnVlV2l0aERlZmF1bHQ6IHRydWUsXG4gIH0pKTtcblxuICAvLyBORVhUIHRhc2sncyBwcm9tcHQgYnVpbGQgXHUyMDE0IG11c3QgTk9UIGNsYWltIHRoZSB1bnJlc29sdmVkIGF3YWl0aW5nX3Jldmlldy5cbiAgY29uc3QgcHJlbWF0dXJlID0gY2xhaW1PdmVycmlkZUZvckluamVjdGlvbihiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIik7XG4gIGFzc2VydC5lcXVhbChwcmVtYXR1cmUsIG51bGwsIFwiYXdhaXRpbmdfcmV2aWV3IHdpdGhvdXQgcmVzcG9uZGVkQXQgbXVzdCBub3QgYmUgY2xhaW1lZFwiKTtcblxuICBjb25zdCBtaWRTdGF0ZSA9IGdldFRhc2soXCJNMDAxXCIsIFwiUzAxXCIsIFwiVDA5YVwiKTtcbiAgYXNzZXJ0LmVxdWFsKG1pZFN0YXRlPy5lc2NhbGF0aW9uX292ZXJyaWRlX2FwcGxpZWRfYXQsIG51bGwsIFwiYXBwbGllZF9hdCBtdXN0IHN0aWxsIGJlIG51bGxcIik7XG5cbiAgLy8gVXNlciBub3cgcmVzb2x2ZXMuXG4gIHJlc29sdmVFc2NhbGF0aW9uKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQwOWFcIiwgXCJCXCIsIFwiYWN0dWFsbHkgQiBpcyBiZXR0ZXJcIik7XG5cbiAgLy8gTkVYVCB0YXNrJ3MgcHJvbXB0IGJ1aWxkIFx1MjAxNCBOT1cgdGhlIG92ZXJyaWRlIG11c3QgYmUgY2xhaW1lZCBhbmQgaW5qZWN0ZWQuXG4gIGNvbnN0IGNsYWltZWQgPSBjbGFpbU92ZXJyaWRlRm9ySW5qZWN0aW9uKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiKTtcbiAgYXNzZXJ0Lm9rKGNsYWltZWQsIFwiYWZ0ZXIgdXNlciByZXNvbHV0aW9uLCB0aGUgb3ZlcnJpZGUgbXVzdCBiZSBpbmplY3RhYmxlXCIpO1xuICBhc3NlcnQuZXF1YWwoY2xhaW1lZCEuc291cmNlVGFza0lkLCBcIlQwOWFcIik7XG4gIGFzc2VydC5tYXRjaChjbGFpbWVkIS5pbmplY3Rpb25CbG9jaywgL0VzY2FsYXRpb24gT3ZlcnJpZGUvKTtcbn0pO1xuXG50ZXN0KFwiQURSLTAxMSBQMjogY2xhaW1PdmVycmlkZUZvckluamVjdGlvbiByZXR1cm5zIG1hcmtkb3duIGJsb2NrIG9uY2UsIHRoZW4gbnVsbFwiLCAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGJhc2UpKTtcbiAgc2VlZENvbXBsZXRlZFRhc2soYmFzZSwgXCJUMTBcIik7XG5cbiAgd3JpdGVFc2NhbGF0aW9uQXJ0aWZhY3QoYmFzZSwgYnVpbGRFc2NhbGF0aW9uQXJ0aWZhY3Qoe1xuICAgIHRhc2tJZDogXCJUMTBcIiwgc2xpY2VJZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIHF1ZXN0aW9uOiBcIldoaWNoIHN0b3JhZ2U/XCIsXG4gICAgb3B0aW9uczogc2FtcGxlT3B0aW9ucyxcbiAgICByZWNvbW1lbmRhdGlvbjogXCJBXCIsXG4gICAgcmVjb21tZW5kYXRpb25SYXRpb25hbGU6IFwiclwiLFxuICAgIGNvbnRpbnVlV2l0aERlZmF1bHQ6IGZhbHNlLFxuICB9KSk7XG4gIHJlc29sdmVFc2NhbGF0aW9uKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQxMFwiLCBcIkFcIiwgXCJwaWNrIEFcIik7XG5cbiAgY29uc3QgZmlyc3QgPSBjbGFpbU92ZXJyaWRlRm9ySW5qZWN0aW9uKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiKTtcbiAgYXNzZXJ0Lm9rKGZpcnN0LCBcImZpcnN0IGNsYWltIHJldHVybnMgdGhlIG92ZXJyaWRlXCIpO1xuICBhc3NlcnQubWF0Y2goZmlyc3QhLmluamVjdGlvbkJsb2NrLCAvRXNjYWxhdGlvbiBPdmVycmlkZS8pO1xuICBhc3NlcnQuZXF1YWwoZmlyc3QhLnNvdXJjZVRhc2tJZCwgXCJUMTBcIik7XG5cbiAgY29uc3Qgc2Vjb25kID0gY2xhaW1PdmVycmlkZUZvckluamVjdGlvbihiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIik7XG4gIGFzc2VydC5lcXVhbChzZWNvbmQsIG51bGwsIFwic2Vjb25kIGNhbGwgcmV0dXJucyBudWxsIChpZGVtcG90ZW50KVwiKTtcbn0pO1xuXG50ZXN0KFwiQURSLTAxMSBQMjogbGlzdEVzY2FsYXRpb25BcnRpZmFjdHMgZmlsdGVycyB0byBhY3Rpb25hYmxlIGJ5IGRlZmF1bHRcIiwgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChiYXNlKSk7XG4gIHNlZWRDb21wbGV0ZWRUYXNrKGJhc2UsIFwiVDExXCIpO1xuICBzZWVkQ29tcGxldGVkVGFzayhiYXNlLCBcIlQxMlwiKTtcblxuICAvLyBQZW5kaW5nIChhY3Rpb25hYmxlKVxuICB3cml0ZUVzY2FsYXRpb25BcnRpZmFjdChiYXNlLCBidWlsZEVzY2FsYXRpb25BcnRpZmFjdCh7XG4gICAgdGFza0lkOiBcIlQxMVwiLCBzbGljZUlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgcXVlc3Rpb246IFwiUVwiLCBvcHRpb25zOiBzYW1wbGVPcHRpb25zLCByZWNvbW1lbmRhdGlvbjogXCJBXCIsIHJlY29tbWVuZGF0aW9uUmF0aW9uYWxlOiBcInJcIixcbiAgICBjb250aW51ZVdpdGhEZWZhdWx0OiBmYWxzZSxcbiAgfSkpO1xuICAvLyBSZXNvbHZlZCAobm90IGFjdGlvbmFibGUgYnkgZGVmYXVsdClcbiAgd3JpdGVFc2NhbGF0aW9uQXJ0aWZhY3QoYmFzZSwgYnVpbGRFc2NhbGF0aW9uQXJ0aWZhY3Qoe1xuICAgIHRhc2tJZDogXCJUMTJcIiwgc2xpY2VJZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIHF1ZXN0aW9uOiBcIlFcIiwgb3B0aW9uczogc2FtcGxlT3B0aW9ucywgcmVjb21tZW5kYXRpb246IFwiQVwiLCByZWNvbW1lbmRhdGlvblJhdGlvbmFsZTogXCJyXCIsXG4gICAgY29udGludWVXaXRoRGVmYXVsdDogZmFsc2UsXG4gIH0pKTtcbiAgcmVzb2x2ZUVzY2FsYXRpb24oYmFzZSwgXCJNMDAxXCIsIFwiUzAxXCIsIFwiVDEyXCIsIFwiQVwiLCBcIlwiKTtcblxuICBjb25zdCBhY3Rpb25hYmxlID0gbGlzdEVzY2FsYXRpb25BcnRpZmFjdHMoXCJNMDAxXCIsIGZhbHNlKTtcbiAgY29uc3QgYWxsID0gbGlzdEVzY2FsYXRpb25BcnRpZmFjdHMoXCJNMDAxXCIsIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoYWN0aW9uYWJsZS5sZW5ndGgsIDEsIFwib25seSBUMTEgaXMgYWN0aW9uYWJsZVwiKTtcbiAgYXNzZXJ0LmVxdWFsKGFjdGlvbmFibGVbMF0hLmlkLCBcIlQxMVwiKTtcbiAgYXNzZXJ0LmVxdWFsKGFsbC5sZW5ndGgsIDIsIFwiYm90aCBzdXJmYWNlIHdpdGggLS1hbGxcIik7XG59KTtcblxudGVzdChcIkFEUi0wMTEgUDI6IHNjaGVtYSB2MjAgZnJlc2ggREIgaGFzIGFsbCBlc2NhbGF0aW9uIGNvbHVtbnMgb24gdGFza3MgKyBzb3VyY2Ugb24gZGVjaXNpb25zXCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuXG4gIGNvbnN0IGFkYXB0ZXIgPSBfZ2V0QWRhcHRlcigpITtcbiAgY29uc3QgdGFza3NDb2xzID0gYWRhcHRlci5wcmVwYXJlKFwiUFJBR01BIHRhYmxlX2luZm8odGFza3MpXCIpLmFsbCgpLm1hcCgocikgPT4gcltcIm5hbWVcIl0gYXMgc3RyaW5nKTtcbiAgZm9yIChjb25zdCBjb2wgb2YgW1xuICAgIFwiYmxvY2tlcl9zb3VyY2VcIixcbiAgICBcImVzY2FsYXRpb25fcGVuZGluZ1wiLFxuICAgIFwiZXNjYWxhdGlvbl9hd2FpdGluZ19yZXZpZXdcIixcbiAgICBcImVzY2FsYXRpb25fYXJ0aWZhY3RfcGF0aFwiLFxuICAgIFwiZXNjYWxhdGlvbl9vdmVycmlkZV9hcHBsaWVkX2F0XCIsXG4gIF0pIHtcbiAgICBhc3NlcnQub2sodGFza3NDb2xzLmluY2x1ZGVzKGNvbCksIGB0YXNrcyB0YWJsZSBtdXN0IGhhdmUgJHtjb2x9IGNvbHVtbmApO1xuICB9XG5cbiAgY29uc3QgZGVjQ29scyA9IGFkYXB0ZXIucHJlcGFyZShcIlBSQUdNQSB0YWJsZV9pbmZvKGRlY2lzaW9ucylcIikuYWxsKCkubWFwKChyKSA9PiByW1wibmFtZVwiXSBhcyBzdHJpbmcpO1xuICBhc3NlcnQub2soZGVjQ29scy5pbmNsdWRlcyhcInNvdXJjZVwiKSwgXCJkZWNpc2lvbnMgdGFibGUgbXVzdCBoYXZlIHNvdXJjZSBjb2x1bW5cIik7XG5cbiAgY29uc3QgdmVyc2lvbiA9IGFkYXB0ZXIucHJlcGFyZShcIlNFTEVDVCBNQVgodmVyc2lvbikgYXMgdiBGUk9NIHNjaGVtYV92ZXJzaW9uXCIpLmdldCgpO1xuICBhc3NlcnQuZXF1YWwodmVyc2lvbj8uW1widlwiXSwgU0NIRU1BX1ZFUlNJT04pO1xufSk7XG5cbnRlc3QoXCJBRFItMDExIFAyOiBmaW5kVW5hcHBsaWVkRXNjYWxhdGlvbk92ZXJyaWRlIHJldHVybnMgbnVsbCB3aGVuIGVzY2FsYXRpb25fcGVuZGluZz0xIChzdGlsbCBwZW5kaW5nKVwiLCAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGJhc2UpKTtcbiAgc2VlZENvbXBsZXRlZFRhc2soYmFzZSwgXCJUMTNcIik7XG5cbiAgd3JpdGVFc2NhbGF0aW9uQXJ0aWZhY3QoYmFzZSwgYnVpbGRFc2NhbGF0aW9uQXJ0aWZhY3Qoe1xuICAgIHRhc2tJZDogXCJUMTNcIiwgc2xpY2VJZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIHF1ZXN0aW9uOiBcIlFcIiwgb3B0aW9uczogc2FtcGxlT3B0aW9ucywgcmVjb21tZW5kYXRpb246IFwiQVwiLCByZWNvbW1lbmRhdGlvblJhdGlvbmFsZTogXCJyXCIsXG4gICAgY29udGludWVXaXRoRGVmYXVsdDogZmFsc2UsXG4gIH0pKTtcblxuICAvLyBEb24ndCByZXNvbHZlIFx1MjAxNCBqdXN0IHF1ZXJ5LlxuICBjb25zdCBmb3VuZCA9IGZpbmRVbmFwcGxpZWRFc2NhbGF0aW9uT3ZlcnJpZGUoXCJNMDAxXCIsIFwiUzAxXCIpO1xuICBhc3NlcnQuZXF1YWwoZm91bmQsIG51bGwsIFwicGVuZGluZyBlc2NhbGF0aW9uIG11c3Qgbm90IHN1cmZhY2UgYXMgdW5hcHBsaWVkIG92ZXJyaWRlXCIpO1xufSk7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gQURSLTAxMSBQaGFzZSAzIGludGVncmF0aW9uLXN0eWxlIHRlc3RzIChjb25jdXJyZW50IC8gdGltZW91dCAvIHJlY292ZXJ5IC9cbi8vIGxhdGVuY3kgXHUyMDE0IGFkYXB0ZWQgZnJvbSByZWZpbmUtc2xpY2UgcGhhc2UgcGF0dGVybnMpLlxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoXCJBRFItMDExIFAzOiBjb25jdXJyZW50IGVzY2FsYXRpb25zIHF1ZXVlIGluIGFycml2YWwgb3JkZXIgXHUyMDE0IGxpc3QgcmV0dXJucyBtdWx0aXBsZVwiLCAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGJhc2UpKTtcbiAgc2VlZENvbXBsZXRlZFRhc2soYmFzZSwgXCJUMjBcIik7XG4gIHNlZWRDb21wbGV0ZWRUYXNrKGJhc2UsIFwiVDIxXCIpO1xuXG4gIHdyaXRlRXNjYWxhdGlvbkFydGlmYWN0KGJhc2UsIGJ1aWxkRXNjYWxhdGlvbkFydGlmYWN0KHtcbiAgICB0YXNrSWQ6IFwiVDIwXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICBxdWVzdGlvbjogXCJRMVwiLCBvcHRpb25zOiBzYW1wbGVPcHRpb25zLCByZWNvbW1lbmRhdGlvbjogXCJBXCIsIHJlY29tbWVuZGF0aW9uUmF0aW9uYWxlOiBcInJcIixcbiAgICBjb250aW51ZVdpdGhEZWZhdWx0OiBmYWxzZSxcbiAgfSkpO1xuICB3cml0ZUVzY2FsYXRpb25BcnRpZmFjdChiYXNlLCBidWlsZEVzY2FsYXRpb25BcnRpZmFjdCh7XG4gICAgdGFza0lkOiBcIlQyMVwiLCBzbGljZUlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgcXVlc3Rpb246IFwiUTJcIiwgb3B0aW9uczogc2FtcGxlT3B0aW9ucywgcmVjb21tZW5kYXRpb246IFwiQlwiLCByZWNvbW1lbmRhdGlvblJhdGlvbmFsZTogXCJyXCIsXG4gICAgY29udGludWVXaXRoRGVmYXVsdDogZmFsc2UsXG4gIH0pKTtcblxuICBjb25zdCBwZW5kaW5nID0gbGlzdEVzY2FsYXRpb25BcnRpZmFjdHMoXCJNMDAxXCIsIGZhbHNlKTtcbiAgYXNzZXJ0LmVxdWFsKHBlbmRpbmcubGVuZ3RoLCAyKTtcbiAgLy8gQm90aCBhcmUgcGF1c2Utd29ydGh5IFx1MjAxNCBzdGF0ZSBkZXJpdmF0aW9uIHJldHVybnMgdGhlIGZpcnN0LlxuICBjb25zdCBmaXJzdCA9IGRldGVjdFBlbmRpbmdFc2NhbGF0aW9uKFtnZXRUYXNrKFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQyMFwiKSEsIGdldFRhc2soXCJNMDAxXCIsIFwiUzAxXCIsIFwiVDIxXCIpIV0sIGJhc2UpO1xuICBhc3NlcnQuZXF1YWwoZmlyc3QsIFwiVDIwXCIsIFwiZGV0ZWN0aW9uIHJldHVybnMgZmlyc3QgcGVuZGluZyBpbiBhcnJpdmFsIG9yZGVyXCIpO1xufSk7XG5cbnRlc3QoXCJBRFItMDExIFAzOiByZWNvdmVyeSBcdTIwMTQgbWFsZm9ybWVkIGFydGlmYWN0IHJldHVybnMgbnVsbCBmcm9tIHJlYWQsIGRvZXMgbm90IGNyYXNoXCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuICBzZWVkQ29tcGxldGVkVGFzayhiYXNlLCBcIlQyMlwiKTtcblxuICBjb25zdCBhcnRQYXRoID0gZXNjYWxhdGlvbkFydGlmYWN0UGF0aChiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMjJcIikhO1xuICBta2RpclN5bmMoam9pbihhcnRQYXRoLCBcIi4uXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhhcnRQYXRoLCBcInsgdGhpcyBpcyBub3QganNvblwiKTtcbiAgY29uc3QgcmVzdWx0ID0gcmVhZEVzY2FsYXRpb25BcnRpZmFjdChhcnRQYXRoKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgbnVsbCwgXCJtYWxmb3JtZWQgSlNPTiBtdXN0IHJldHVybiBudWxsIChubyB0aHJvdylcIik7XG59KTtcblxudGVzdChcIkFEUi0wMTEgUDM6IHJlc29sdmUtb24tbWlzc2luZy1hcnRpZmFjdCByZXR1cm5zIG5vdC1mb3VuZCB3aXRob3V0IHBhcnRpYWwgc3RhdGVcIiwgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChiYXNlKSk7XG4gIHNlZWRDb21wbGV0ZWRUYXNrKGJhc2UsIFwiVDIzXCIpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVFc2NhbGF0aW9uKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQyM1wiLCBcIkFcIiwgXCJcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdHVzLCBcIm5vdC1mb3VuZFwiKTtcbiAgY29uc3Qgcm93ID0gZ2V0VGFzayhcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMjNcIik7XG4gIGFzc2VydC5lcXVhbChyb3c/LmVzY2FsYXRpb25fcGVuZGluZywgMCwgXCJ1bnRvdWNoZWRcIik7XG59KTtcblxudGVzdChcIkFEUi0wMTEgUDM6IGVzY2FsYXRpb24gd3JpdGUgKyBkZXRlY3QgbGF0ZW5jeSBcdTIwMTQgMjAgdGFza3MsIG9uZSBlc2NhbGF0aW9uLCBkZXRlY3Rpb24gdW5kZXIgMTAwbXNcIiwgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChiYXNlKSk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7XG4gIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiU2xpY2VcIiB9KTtcbiAgZm9yIChsZXQgaSA9IDE7IGkgPD0gMjA7IGkrKykge1xuICAgIGNvbnN0IHRpZCA9IGBUJHtTdHJpbmcoaSkucGFkU3RhcnQoMiwgXCIwXCIpfWA7XG4gICAgaW5zZXJ0VGFzayh7IGlkOiB0aWQsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IGBUYXNrICR7aX1gLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KTtcbiAgfVxuICAvLyBFc2NhbGF0aW9uIG9uIFQxNSBvbmx5LlxuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiLCBcInRhc2tzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVFc2NhbGF0aW9uQXJ0aWZhY3QoYmFzZSwgYnVpbGRFc2NhbGF0aW9uQXJ0aWZhY3Qoe1xuICAgIHRhc2tJZDogXCJUMTVcIiwgc2xpY2VJZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIHF1ZXN0aW9uOiBcIlFcIiwgb3B0aW9uczogc2FtcGxlT3B0aW9ucywgcmVjb21tZW5kYXRpb246IFwiQVwiLCByZWNvbW1lbmRhdGlvblJhdGlvbmFsZTogXCJyXCIsXG4gICAgY29udGludWVXaXRoRGVmYXVsdDogZmFsc2UsXG4gIH0pKTtcblxuICBjb25zdCB0YXNrcyA9IEFycmF5LmZyb20oeyBsZW5ndGg6IDIwIH0sIChfLCBpKSA9PiBnZXRUYXNrKFwiTTAwMVwiLCBcIlMwMVwiLCBgVCR7U3RyaW5nKGkgKyAxKS5wYWRTdGFydCgyLCBcIjBcIil9YCkhKTtcbiAgY29uc3Qgc3RhcnQgPSBEYXRlLm5vdygpO1xuICBjb25zdCBmb3VuZCA9IGRldGVjdFBlbmRpbmdFc2NhbGF0aW9uKHRhc2tzLCBiYXNlKTtcbiAgY29uc3QgZWxhcHNlZCA9IERhdGUubm93KCkgLSBzdGFydDtcbiAgYXNzZXJ0LmVxdWFsKGZvdW5kLCBcIlQxNVwiKTtcbiAgYXNzZXJ0Lm9rKGVsYXBzZWQgPCAxMDAsIGBkZXRlY3Rpb24gbXVzdCBjb21wbGV0ZSB1bmRlciAxMDBtcywgdG9vayAke2VsYXBzZWR9bXNgKTtcbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIEFEUi0wMTEgUGhhc2UgMyBcdTIwMTQgSW50ZWdyYXRpb246IE1pZC1FeGVjdXRpb24gRXNjYWxhdGlvblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoXCJBRFItMDExIFAzICMyMDogRTJFIGVzY2FsYXRpb24gbGlmZWN5Y2xlIFx1MjAxNCB3cml0ZSBcdTIxOTIgcGF1c2UgXHUyMTkyIHJlc29sdmUgXHUyMTkyIHJlc3VtZSB2aWEgb3ZlcnJpZGUgaW5qZWN0aW9uXCIsICh0KSA9PiB7XG4gIC8vIEV4ZXJjaXNlcyB0aGUgZnVsbCBlc2NhbGF0aW9uIGxvb3AgYWNyb3NzIHR3byB0YXNrcyBpbiBvbmUgc2xpY2U6XG4gIC8vICAgMS4gRXhlY3V0b3Igd3JpdGVzIEVTQ0FMQVRJT04uanNvbiBvbiBUMzAgd2l0aCBjb250aW51ZVdpdGhEZWZhdWx0PWZhbHNlLlxuICAvLyAgIDIuIGRldGVjdFBlbmRpbmdFc2NhbGF0aW9uIHJldHVybnMgVDMwIChzdGF0ZS50czo5OTggaXMgd2hhdCBwYXVzZXMgdGhlIGxvb3ApLlxuICAvLyAgIDMuIFVzZXIgY2FsbHMgcmVzb2x2ZUVzY2FsYXRpb24gd2l0aCBhIHNwZWNpZmljIG9wdGlvbiBjaG9pY2UuXG4gIC8vICAgNC4gZGV0ZWN0UGVuZGluZ0VzY2FsYXRpb24gcmV0dXJucyBudWxsIFx1MjAxNCBwYXVzZSBjb25kaXRpb24gY2xlYXJlZC5cbiAgLy8gICA1LiBUaGUgKm5leHQqIHRhc2sgKFQzMSkgaW4gdGhlIHNsaWNlIHBpY2tzIHVwIHRoZSBvdmVycmlkZSBibG9jayB2aWFcbiAgLy8gICAgICBjbGFpbU92ZXJyaWRlRm9ySW5qZWN0aW9uIGV4YWN0bHkgb25jZSAoaWRlbXBvdGVudCBhY3Jvc3MgcmV0cmllcykuXG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuICBzZWVkQ29tcGxldGVkVGFzayhiYXNlLCBcIlQzMFwiKTtcbiAgc2VlZENvbXBsZXRlZFRhc2soYmFzZSwgXCJUMzFcIik7XG5cbiAgLy8gU3RlcCAxOiBleGVjdXRvciBlc2NhbGF0ZXMgb24gVDMwIChwYXVzZS1zY29wZWQpLlxuICB3cml0ZUVzY2FsYXRpb25BcnRpZmFjdChiYXNlLCBidWlsZEVzY2FsYXRpb25BcnRpZmFjdCh7XG4gICAgdGFza0lkOiBcIlQzMFwiLCBzbGljZUlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgcXVlc3Rpb246IFwiU3RvcmFnZSBmb3JtYXQgZm9yIHRoZSBuZXcgbWV0cmljcyB0YWJsZT9cIixcbiAgICBvcHRpb25zOiBzYW1wbGVPcHRpb25zLCByZWNvbW1lbmRhdGlvbjogXCJBXCIsIHJlY29tbWVuZGF0aW9uUmF0aW9uYWxlOiBcIkEgaXMgc2ltcGxlclwiLFxuICAgIGNvbnRpbnVlV2l0aERlZmF1bHQ6IGZhbHNlLFxuICB9KSk7XG5cbiAgLy8gU3RlcCAyOiBzY2hlZHVsZXIgc2VlcyB0aGUgcGF1c2Ugc2lnbmFsLlxuICBsZXQgdGFza3MgPSBbZ2V0VGFzayhcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMzBcIikhLCBnZXRUYXNrKFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQzMVwiKSFdO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgZGV0ZWN0UGVuZGluZ0VzY2FsYXRpb24odGFza3MsIGJhc2UpLFxuICAgIFwiVDMwXCIsXG4gICAgXCJzY2hlZHVsZXIgbXVzdCBwYXVzZSBvbiBUMzAgYmVmb3JlIGRpc3BhdGNoaW5nIFQzMVwiLFxuICApO1xuXG4gIC8vIENsYWltIGF0dGVtcHRlZCBtaWQtcGF1c2UgbXVzdCBmYWlsIChvdmVycmlkZSBub3QgeWV0IHJlc29sdmVkKS5cbiAgYXNzZXJ0LmVxdWFsKFxuICAgIGNsYWltT3ZlcnJpZGVGb3JJbmplY3Rpb24oYmFzZSwgXCJNMDAxXCIsIFwiUzAxXCIpLFxuICAgIG51bGwsXG4gICAgXCJubyBpbmplY3Rpb24gc2hvdWxkIGZpcmUgd2hpbGUgZXNjYWxhdGlvbiBpcyBzdGlsbCBwZW5kaW5nXCIsXG4gICk7XG5cbiAgLy8gU3RlcCAzOiB1c2VyIHJlc3BvbmRzIHdpdGggb3B0aW9uIEIgKyByYXRpb25hbGUuXG4gIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVFc2NhbGF0aW9uKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQzMFwiLCBcIkJcIiwgXCJCIGZpdHMgYmV0dGVyXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXR1cywgXCJyZXNvbHZlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jaG9zZW5PcHRpb24/LmlkLCBcIkJcIik7XG5cbiAgLy8gU3RlcCA0OiBwYXVzZSBjb25kaXRpb24gY2xlYXJzLlxuICB0YXNrcyA9IFtnZXRUYXNrKFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQzMFwiKSEsIGdldFRhc2soXCJNMDAxXCIsIFwiUzAxXCIsIFwiVDMxXCIpIV07XG4gIGFzc2VydC5lcXVhbChcbiAgICBkZXRlY3RQZW5kaW5nRXNjYWxhdGlvbih0YXNrcywgYmFzZSksXG4gICAgbnVsbCxcbiAgICBcImFmdGVyIHJlc29sdmUsIHNjaGVkdWxlciBtdXN0IG5vdCByZS1wYXVzZSBvbiBUMzBcIixcbiAgKTtcblxuICAvLyBTdGVwIDU6IG5leHQgdGFzayAoVDMxKSBwaWNrcyB1cCB0aGUgb3ZlcnJpZGUgZXhhY3RseSBvbmNlLlxuICBjb25zdCBpbmplY3RlZCA9IGNsYWltT3ZlcnJpZGVGb3JJbmplY3Rpb24oYmFzZSwgXCJNMDAxXCIsIFwiUzAxXCIpO1xuICBhc3NlcnQub2soaW5qZWN0ZWQsIFwiVDMxJ3MgcHJvbXB0IGJ1aWxkIG11c3QgY2xhaW0gdGhlIHJlc29sdmVkIG92ZXJyaWRlXCIpO1xuICBhc3NlcnQuZXF1YWwoaW5qZWN0ZWQhLnNvdXJjZVRhc2tJZCwgXCJUMzBcIik7XG4gIGFzc2VydC5tYXRjaChpbmplY3RlZCEuaW5qZWN0aW9uQmxvY2ssIC9Fc2NhbGF0aW9uIE92ZXJyaWRlLyk7XG4gIGFzc2VydC5tYXRjaChpbmplY3RlZCEuaW5qZWN0aW9uQmxvY2ssIC9CLywgXCJpbmplY3Rpb24gbXVzdCByZWZsZWN0IHVzZXIncyBjaG9zZW4gb3B0aW9uIGlkXCIpO1xuXG4gIGNvbnN0IHNlY29uZENsYWltID0gY2xhaW1PdmVycmlkZUZvckluamVjdGlvbihiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIik7XG4gIGFzc2VydC5lcXVhbChzZWNvbmRDbGFpbSwgbnVsbCwgXCJvdmVycmlkZSBtdXN0IGJlIGNvbnN1bWVkIGV4YWN0bHkgb25jZVwiKTtcbn0pO1xuXG50ZXN0KFwiQURSLTAxMSBQMyAjMjE6IGJsb2NrZXIgdGFrZXMgcHJpb3JpdHkgb3ZlciBlc2NhbGF0aW9uIHdoZW4gYm90aCBmbGFncyBjb2V4aXN0IG9uIHNhbWUgdGFza1wiLCAodCkgPT4ge1xuICAvLyBUd28gaW52YXJpYW50cyB0b2dldGhlciBnaXZlIGJsb2NrZXItcHJpb3JpdHk6XG4gIC8vICAgYSkgc3RhdGUudHM6OTc3LTk5MSBjaGVja3MgZGV0ZWN0QmxvY2tlcnMgQkVGT1JFIHRoZSBlc2NhbGF0aW9uIGJyYW5jaFxuICAvLyAgICAgIGF0IHN0YXRlLnRzOjk5Ni0xMDEwLCBzbyBhIGJsb2NrZXIgZmxhZyBzaG9ydC1jaXJjdWl0cyB0aGUgZXNjYWxhdGlvblxuICAvLyAgICAgIHBhdXNlLlxuICAvLyAgIGIpIHJlc29sdmVFc2NhbGF0aW9uKHJlamVjdC1ibG9ja2VyKSBhdG9taWNhbGx5IGNsZWFycyBlc2NhbGF0aW9uIGZsYWdzXG4gIC8vICAgICAgQU5EIHNldHMgYmxvY2tlcl9kaXNjb3ZlcmVkPTEgKGVzY2FsYXRpb24udHM6MjI3LTIzMCksIHNvIHRoZXJlIGlzIG5vXG4gIC8vICAgICAgcG9zdC1yZXNvbHZlIHdpbmRvdyB3aGVyZSBib3RoIGZsYWdzIGNvdWxkIHN1cmZhY2Ugc2ltdWx0YW5lb3VzbHkuXG4gIC8vIFRoaXMgdGVzdCBwaW5zIChiKTogYWZ0ZXIgcmVqZWN0LWJsb2NrZXIsIHRoZSBlc2NhbGF0aW9uIHBhdXNlIHNpZ25hbCBpc1xuICAvLyBnb25lIGFuZCB0aGUgdGFzayBpcyBleGNsdXNpdmVseSBpbiBibG9ja2VyLXN0YXRlLlxuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGJhc2UpKTtcbiAgc2VlZENvbXBsZXRlZFRhc2soYmFzZSwgXCJUNDBcIik7XG5cbiAgd3JpdGVFc2NhbGF0aW9uQXJ0aWZhY3QoYmFzZSwgYnVpbGRFc2NhbGF0aW9uQXJ0aWZhY3Qoe1xuICAgIHRhc2tJZDogXCJUNDBcIiwgc2xpY2VJZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIHF1ZXN0aW9uOiBcIldoaWNoIHN0b3JhZ2U/XCIsIG9wdGlvbnM6IHNhbXBsZU9wdGlvbnMsXG4gICAgcmVjb21tZW5kYXRpb246IFwiQVwiLCByZWNvbW1lbmRhdGlvblJhdGlvbmFsZTogXCJyXCIsXG4gICAgY29udGludWVXaXRoRGVmYXVsdDogZmFsc2UsXG4gIH0pKTtcblxuICAvLyBQcmUtY29uZGl0aW9uOiBlc2NhbGF0aW9uIGlzIGFjdGl2ZSwgYmxvY2tlciBpcyBub3QuXG4gIGxldCByb3cgPSBnZXRUYXNrKFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQ0MFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJvdz8uZXNjYWxhdGlvbl9wZW5kaW5nLCAxKTtcbiAgYXNzZXJ0LmVxdWFsKHJvdz8uYmxvY2tlcl9kaXNjb3ZlcmVkLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbChkZXRlY3RQZW5kaW5nRXNjYWxhdGlvbihbcm93IV0sIGJhc2UpLCBcIlQ0MFwiKTtcblxuICAvLyBVc2VyIHJlamVjdHMgdG8gYmxvY2tlciBcdTIwMTQgc2luZ2xlIHRyYW5zaXRpb24uXG4gIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVFc2NhbGF0aW9uKFxuICAgIGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQ0MFwiLCBcInJlamVjdC1ibG9ja2VyXCIsIFwibm9uZSBvZiB0aGVzZSBmaXQgdGhlIG9ic2VydmVkIGNvbnN0cmFpbnRzXCIsXG4gICk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdHVzLCBcInJlamVjdGVkLXRvLWJsb2NrZXJcIik7XG5cbiAgLy8gUG9zdC1jb25kaXRpb246IGJsb2NrZXIgaXMgc2V0LCBlc2NhbGF0aW9uIGZsYWdzIGFyZSBjbGVhcmVkLlxuICByb3cgPSBnZXRUYXNrKFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQ0MFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJvdz8uYmxvY2tlcl9kaXNjb3ZlcmVkLCB0cnVlLCBcImJsb2NrZXJfZGlzY292ZXJlZCBtdXN0IGJlIHNldCBhZnRlciByZWplY3QtYmxvY2tlclwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJvdz8uYmxvY2tlcl9zb3VyY2UsIFwicmVqZWN0LWVzY2FsYXRpb25cIiwgXCJibG9ja2VyX3NvdXJjZSByZWNvcmRzIHByb3ZlbmFuY2VcIik7XG4gIGFzc2VydC5lcXVhbChyb3c/LmVzY2FsYXRpb25fcGVuZGluZywgMCwgXCJlc2NhbGF0aW9uX3BlbmRpbmcgbXVzdCBiZSBjbGVhcmVkXCIpO1xuICBhc3NlcnQuZXF1YWwocm93Py5lc2NhbGF0aW9uX2F3YWl0aW5nX3JldmlldywgMCwgXCJlc2NhbGF0aW9uX2F3YWl0aW5nX3JldmlldyBtdXN0IGJlIGNsZWFyZWRcIik7XG5cbiAgLy8gZGV0ZWN0UGVuZGluZ0VzY2FsYXRpb24gbXVzdCBubyBsb25nZXIgcmV0dXJuIFQ0MCBcdTIwMTQgc2NoZWR1bGVyIHdvdWxkXG4gIC8vIG90aGVyd2lzZSByYWNlIHRoZSBibG9ja2VyIGJyYW5jaCBhbmQgcGljayB0aGUgd3JvbmcgcGhhc2UuXG4gIGFzc2VydC5lcXVhbChcbiAgICBkZXRlY3RQZW5kaW5nRXNjYWxhdGlvbihbcm93IV0sIGJhc2UpLFxuICAgIG51bGwsXG4gICAgXCJhZnRlciByZWplY3QtYmxvY2tlciwgZXNjYWxhdGlvbiBtdXN0IG5vdCBwYXVzZSBcdTIwMTQgYmxvY2tlciBwYXRoIG93bnMgdGhlIHRhc2tcIixcbiAgKTtcbn0pO1xuXG50ZXN0KFwiQURSLTAxMSBQMyAjMjI6IEFEUi0wMDkgYXVkaXQgZW52ZWxvcGVzIGVtaXR0ZWQgYWNyb3NzIHRoZSBlc2NhbGF0aW9uIGxpZmVjeWNsZVwiLCAodCkgPT4ge1xuICAvLyBWZXJpZmllcyB0aGF0IGV2ZXJ5IHVzZXItdmlzaWJsZSBlc2NhbGF0aW9uIGV2ZW50IHdyaXRlcyBhIHN0cnVjdHVyZWRcbiAgLy8gYXVkaXQgZW52ZWxvcGUgKGV2ZW50SWQsIHRyYWNlSWQsIGNhdGVnb3J5LCB0eXBlLCB0cywgcGF5bG9hZCkgdG9cbiAgLy8gLmdzZC9hdWRpdC9ldmVudHMuanNvbmwuIEFEUi0wMDkgY29udHJvbC1wbGFuZSBjb25zdW1lcnMgZGVwZW5kIG9uIHRoaXNcbiAgLy8gc2hhcGUuIENvdmVyZWQgZXZlbnQgdHlwZXM6XG4gIC8vICAgLSBlc2NhbGF0aW9uLW1hbnVhbC1hdHRlbnRpb24tY3JlYXRlZCAob24gd3JpdGUpXG4gIC8vICAgLSBlc2NhbGF0aW9uLXVzZXItcmVzcG9uZGVkICAgICAgICAgICAgKG9uIHJlc29sdmUgd2l0aCBvcHRpb24pXG4gIC8vICAgLSBlc2NhbGF0aW9uLXJlamVjdGVkLXRvLWJsb2NrZXIgICAgICAgKG9uIHJlamVjdC1ibG9ja2VyKVxuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGJhc2UpKTtcbiAgc2VlZENvbXBsZXRlZFRhc2soYmFzZSwgXCJUNTBcIik7XG4gIHNlZWRDb21wbGV0ZWRUYXNrKGJhc2UsIFwiVDUxXCIpO1xuXG4gIC8vIDEpIHdyaXRlIFx1MjE5MiBjcmVhdGVkXG4gIHdyaXRlRXNjYWxhdGlvbkFydGlmYWN0KGJhc2UsIGJ1aWxkRXNjYWxhdGlvbkFydGlmYWN0KHtcbiAgICB0YXNrSWQ6IFwiVDUwXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICBxdWVzdGlvbjogXCJRNTBcIiwgb3B0aW9uczogc2FtcGxlT3B0aW9ucywgcmVjb21tZW5kYXRpb246IFwiQVwiLCByZWNvbW1lbmRhdGlvblJhdGlvbmFsZTogXCJyXCIsXG4gICAgY29udGludWVXaXRoRGVmYXVsdDogZmFsc2UsXG4gIH0pKTtcblxuICAvLyAyKSByZXNvbHZlKGFjY2VwdCkgXHUyMTkyIHJlc3BvbmRlZFxuICByZXNvbHZlRXNjYWxhdGlvbihiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgXCJUNTBcIiwgXCJhY2NlcHRcIiwgXCJzb3VuZHMgcmlnaHRcIik7XG5cbiAgLy8gMykgYW5vdGhlciB3cml0ZSArIHJlamVjdC1ibG9ja2VyIFx1MjE5MiByZWplY3RlZFxuICB3cml0ZUVzY2FsYXRpb25BcnRpZmFjdChiYXNlLCBidWlsZEVzY2FsYXRpb25BcnRpZmFjdCh7XG4gICAgdGFza0lkOiBcIlQ1MVwiLCBzbGljZUlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgcXVlc3Rpb246IFwiUTUxXCIsIG9wdGlvbnM6IHNhbXBsZU9wdGlvbnMsIHJlY29tbWVuZGF0aW9uOiBcIkJcIiwgcmVjb21tZW5kYXRpb25SYXRpb25hbGU6IFwiclwiLFxuICAgIGNvbnRpbnVlV2l0aERlZmF1bHQ6IGZhbHNlLFxuICB9KSk7XG4gIHJlc29sdmVFc2NhbGF0aW9uKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQ1MVwiLCBcInJlamVjdC1ibG9ja2VyXCIsIFwiYmxvY2tlciBwYXRoXCIpO1xuXG4gIC8vIFJlYWQgYXVkaXQgbG9nIGFuZCBwYXJzZSBlYWNoIEpTT05MIGVudmVsb3BlLlxuICBjb25zdCBsb2dQYXRoID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJhdWRpdFwiLCBcImV2ZW50cy5qc29ubFwiKTtcbiAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMobG9nUGF0aCksIFwiYXVkaXQgbG9nIG11c3QgZXhpc3QgYXQgLmdzZC9hdWRpdC9ldmVudHMuanNvbmxcIik7XG4gIGNvbnN0IGxpbmVzID0gcmVhZEZpbGVTeW5jKGxvZ1BhdGgsIFwidXRmLThcIikuc3BsaXQoXCJcXG5cIikuZmlsdGVyKChsKSA9PiBsLmxlbmd0aCA+IDApO1xuICBjb25zdCBldmVudHMgPSBsaW5lcy5tYXAoKGwpID0+IEpTT04ucGFyc2UobCkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pO1xuICBjb25zdCBlc2NhbGF0aW9uRXZlbnRzID0gZXZlbnRzLmZpbHRlcigoZSkgPT4gdHlwZW9mIGVbXCJ0eXBlXCJdID09PSBcInN0cmluZ1wiICYmIChlW1widHlwZVwiXSBhcyBzdHJpbmcpLnN0YXJ0c1dpdGgoXCJlc2NhbGF0aW9uLVwiKSk7XG5cbiAgLy8gQWxsIGZvdXIgbGlmZWN5Y2xlIGV2ZW50cyBtdXN0IGJlIHByZXNlbnQuXG4gIGNvbnN0IHR5cGVzID0gZXNjYWxhdGlvbkV2ZW50cy5tYXAoKGUpID0+IGVbXCJ0eXBlXCJdIGFzIHN0cmluZykuc29ydCgpO1xuICBhc3NlcnQuZGVlcEVxdWFsKHR5cGVzLCBbXG4gICAgXCJlc2NhbGF0aW9uLW1hbnVhbC1hdHRlbnRpb24tY3JlYXRlZFwiLFxuICAgIFwiZXNjYWxhdGlvbi1tYW51YWwtYXR0ZW50aW9uLWNyZWF0ZWRcIixcbiAgICBcImVzY2FsYXRpb24tcmVqZWN0ZWQtdG8tYmxvY2tlclwiLFxuICAgIFwiZXNjYWxhdGlvbi11c2VyLXJlc3BvbmRlZFwiLFxuICBdKTtcblxuICAvLyBFdmVyeSBlbnZlbG9wZSBtdXN0IGNhcnJ5IHRoZSBBRFItMDA5IGNvbnRyYWN0IGZpZWxkcy5cbiAgZm9yIChjb25zdCBlbnYgb2YgZXNjYWxhdGlvbkV2ZW50cykge1xuICAgIGFzc2VydC5lcXVhbCh0eXBlb2YgZW52W1wiZXZlbnRJZFwiXSwgXCJzdHJpbmdcIiwgXCJlbnZlbG9wZSBtdXN0IGluY2x1ZGUgZXZlbnRJZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwodHlwZW9mIGVudltcInRyYWNlSWRcIl0sIFwic3RyaW5nXCIsIFwiZW52ZWxvcGUgbXVzdCBpbmNsdWRlIHRyYWNlSWRcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKGVudltcInRyYWNlSWRcIl0gYXMgc3RyaW5nLCAvXmVzY2FsYXRpb246TTAwMTpTMDE6VDVbMDFdJC8sIFwidHJhY2VJZCBtdXN0IGJlIHN0YWJsZSBhbmQgdGFzay1zY29wZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGVudltcImNhdGVnb3J5XCJdLCBcImdhdGVcIiwgXCJlc2NhbGF0aW9uIGV2ZW50cyBiZWxvbmcgdG8gdGhlIGdhdGUgY29udHJvbCBwbGFuZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwodHlwZW9mIGVudltcInRzXCJdLCBcInN0cmluZ1wiKTtcbiAgICBhc3NlcnQub2soZW52W1wicGF5bG9hZFwiXSAmJiB0eXBlb2YgZW52W1wicGF5bG9hZFwiXSA9PT0gXCJvYmplY3RcIiwgXCJwYXlsb2FkIG11c3QgYmUgYW4gb2JqZWN0XCIpO1xuICAgIGNvbnN0IHBheWxvYWQgPSBlbnZbXCJwYXlsb2FkXCJdIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGFzc2VydC5lcXVhbChwYXlsb2FkW1wibWlsZXN0b25lSWRcIl0sIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocGF5bG9hZFtcInNsaWNlSWRcIl0sIFwiUzAxXCIpO1xuICAgIGFzc2VydC5vayhwYXlsb2FkW1widGFza0lkXCJdID09PSBcIlQ1MFwiIHx8IHBheWxvYWRbXCJ0YXNrSWRcIl0gPT09IFwiVDUxXCIpO1xuICB9XG59KTtcblxudGVzdChcIkFEUi0wMTEgUDMgIzIzOiBjb25jdXJyZW50IGVzY2FsYXRpb25zIGFjcm9zcyBwYXJhbGxlbCBzbGljZXMgXHUyMDE0IG9ubHkgdGhlIGVzY2FsYXRpbmcgYnJhbmNoIHBhdXNlc1wiLCAodCkgPT4ge1xuICAvLyBJbiBwYXJhbGxlbC1zbGljZSBleGVjdXRpb24gZWFjaCBzbGljZSBoYXMgaXRzIG93biBhY3RpdmUtdGFzayB2aWV3LlxuICAvLyBUaGUgc2NoZWR1bGVyIGNhbGxzIGRldGVjdFBlbmRpbmdFc2NhbGF0aW9uKHRhc2tzLCBiYXNlKSB3aXRoICp0aGF0XG4gIC8vIHNsaWNlJ3MqIHRhc2tzIG9ubHkgKHN0YXRlLnRzOjk5OCkuIFNvIGlmIFMwMS1UNjAgZXNjYWxhdGVzIGFuZCBTMDItVDcwXG4gIC8vIGRvZXMgbm90LCB0aGUgUzAyIGJyYW5jaCBtdXN0IHJlbWFpbiBkaXNwYXRjaGFibGUgd2hpbGUgUzAxIHdhaXRzLlxuICAvL1xuICAvLyBUaGlzIHRlc3QgcGluczogKGEpIGVhY2ggc2xpY2UncyBkZXRlY3RQZW5kaW5nRXNjYWxhdGlvbiByZXR1cm5zIG9ubHlcbiAgLy8gaXRzIG93biBwZW5kaW5nIHRhc2tzLCAoYikgbmVpdGhlciBicmFuY2ggY2FuIHNlZSB0aGUgb3RoZXInc1xuICAvLyBlc2NhbGF0aW9uIGJ5IGFjY2lkZW50LCBhbmQgKGMpIHJlc29sdmluZyBvbmUgc2xpY2UncyBlc2NhbGF0aW9uIGRvZXNcbiAgLy8gbm90IGNsZWFyIHRoZSBvdGhlcidzIHBhdXNlIHNpZ25hbC5cbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChiYXNlKSk7XG5cbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcbiAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJTbGljZSBBXCIgfSk7XG4gIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAyXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiU2xpY2UgQlwiIH0pO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMlwiLCBcInRhc2tzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgaW5zZXJ0VGFzayh7IGlkOiBcIlQ2MFwiLCBzbGljZUlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRhc2sgQVwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KTtcbiAgaW5zZXJ0VGFzayh7IGlkOiBcIlQ3MFwiLCBzbGljZUlkOiBcIlMwMlwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRhc2sgQlwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KTtcbiAgaW5zZXJ0VGFzayh7IGlkOiBcIlQ3MVwiLCBzbGljZUlkOiBcIlMwMlwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRhc2sgQjJcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIgfSk7XG5cbiAgLy8gQm90aCBzbGljZXMgZXNjYWxhdGUgYXQgdGhlIHNhbWUgdGltZSAocGFyYWxsZWwgZXhlY3V0aW9uIHNjZW5hcmlvKS5cbiAgd3JpdGVFc2NhbGF0aW9uQXJ0aWZhY3QoYmFzZSwgYnVpbGRFc2NhbGF0aW9uQXJ0aWZhY3Qoe1xuICAgIHRhc2tJZDogXCJUNjBcIiwgc2xpY2VJZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIHF1ZXN0aW9uOiBcIlMwMSBhbWJpZ3VpdHk/XCIsIG9wdGlvbnM6IHNhbXBsZU9wdGlvbnMsXG4gICAgcmVjb21tZW5kYXRpb246IFwiQVwiLCByZWNvbW1lbmRhdGlvblJhdGlvbmFsZTogXCJyXCIsXG4gICAgY29udGludWVXaXRoRGVmYXVsdDogZmFsc2UsXG4gIH0pKTtcbiAgd3JpdGVFc2NhbGF0aW9uQXJ0aWZhY3QoYmFzZSwgYnVpbGRFc2NhbGF0aW9uQXJ0aWZhY3Qoe1xuICAgIHRhc2tJZDogXCJUNzBcIiwgc2xpY2VJZDogXCJTMDJcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIHF1ZXN0aW9uOiBcIlMwMiBhbWJpZ3VpdHk/XCIsIG9wdGlvbnM6IHNhbXBsZU9wdGlvbnMsXG4gICAgcmVjb21tZW5kYXRpb246IFwiQlwiLCByZWNvbW1lbmRhdGlvblJhdGlvbmFsZTogXCJyXCIsXG4gICAgY29udGludWVXaXRoRGVmYXVsdDogZmFsc2UsXG4gIH0pKTtcblxuICAvLyBQZXItc2xpY2UgZGV0ZWN0aW9uOiBlYWNoIGJyYW5jaCBzZWVzIG9ubHkgaXRzIG93biBwZW5kaW5nIHRhc2suXG4gIGNvbnN0IHMwMVRhc2tzID0gW2dldFRhc2soXCJNMDAxXCIsIFwiUzAxXCIsIFwiVDYwXCIpIV07XG4gIGNvbnN0IHMwMlRhc2tzID0gW2dldFRhc2soXCJNMDAxXCIsIFwiUzAyXCIsIFwiVDcwXCIpISwgZ2V0VGFzayhcIk0wMDFcIiwgXCJTMDJcIiwgXCJUNzFcIikhXTtcbiAgYXNzZXJ0LmVxdWFsKGRldGVjdFBlbmRpbmdFc2NhbGF0aW9uKHMwMVRhc2tzLCBiYXNlKSwgXCJUNjBcIik7XG4gIGFzc2VydC5lcXVhbChkZXRlY3RQZW5kaW5nRXNjYWxhdGlvbihzMDJUYXNrcywgYmFzZSksIFwiVDcwXCIpO1xuXG4gIC8vIFJlc29sdmUgUzAxJ3MgZXNjYWxhdGlvbiBcdTIwMTQgbXVzdCBOT1QgY2xlYXIgUzAyJ3MgcGF1c2Ugc2lnbmFsLlxuICByZXNvbHZlRXNjYWxhdGlvbihiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgXCJUNjBcIiwgXCJBXCIsIFwicGljayBBXCIpO1xuICBhc3NlcnQuZXF1YWwoZGV0ZWN0UGVuZGluZ0VzY2FsYXRpb24oW2dldFRhc2soXCJNMDAxXCIsIFwiUzAxXCIsIFwiVDYwXCIpIV0sIGJhc2UpLCBudWxsKTtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIGRldGVjdFBlbmRpbmdFc2NhbGF0aW9uKFtnZXRUYXNrKFwiTTAwMVwiLCBcIlMwMlwiLCBcIlQ3MFwiKSEsIGdldFRhc2soXCJNMDAxXCIsIFwiUzAyXCIsIFwiVDcxXCIpIV0sIGJhc2UpLFxuICAgIFwiVDcwXCIsXG4gICAgXCJyZXNvbHZpbmcgb25lIHNsaWNlJ3MgZXNjYWxhdGlvbiBtdXN0IGxlYXZlIHRoZSBvdGhlciBzbGljZSBwYXVzZWRcIixcbiAgKTtcblxuICAvLyBSZXNvbHZpbmcgUzAyIGluZGVwZW5kZW50bHkgY2xlYXJzIHRoZSBzZWNvbmQgcGF1c2UuXG4gIHJlc29sdmVFc2NhbGF0aW9uKGJhc2UsIFwiTTAwMVwiLCBcIlMwMlwiLCBcIlQ3MFwiLCBcIkJcIiwgXCJwaWNrIEJcIik7XG4gIGFzc2VydC5lcXVhbChkZXRlY3RQZW5kaW5nRXNjYWxhdGlvbihbZ2V0VGFzayhcIk0wMDFcIiwgXCJTMDJcIiwgXCJUNzBcIikhXSwgYmFzZSksIG51bGwpO1xufSk7XG5cbnRlc3QoXCJBRFItMDExIFAzICMyNDogY29udGludWVXaXRoRGVmYXVsdCB0aW1lb3V0IFx1MjAxNCBsYXRlIHVzZXIgcmVzcG9uc2UgaW5qZWN0cyBpbnRvIHRoZSBuZXh0IHRhc2sgZGlzcGF0Y2hlZCBBRlRFUiB0aGUgcmVzcG9uc2VcIiwgKHQpID0+IHtcbiAgLy8gVGltZWxpbmUgdGhpcyB0ZXN0IHBpbnMgKHRoZSBcInRpbWVvdXRcIiBpcyBpbXBsaWNpdCBcdTIwMTQgaXQncyBqdXN0IHRoZVxuICAvLyBlbGFwc2VkIHdhbGwtY2xvY2sgd2hlcmUgdGhlIGxvb3Aga2VlcHMgcnVubmluZyBhZnRlciBUODAnc1xuICAvLyBjb250aW51ZVdpdGhEZWZhdWx0PXRydWUgd3JpdGUpOlxuICAvL1xuICAvLyAgIDEuIFQ4MCB3cml0ZXMgY29udGludWVXaXRoRGVmYXVsdD10cnVlIFx1MjE5MiBhd2FpdGluZ19yZXZpZXc9MSwgbG9vcFxuICAvLyAgICAgIGNvbnRpbnVlcyBkaXNwYXRjaGluZyBUODEsIFQ4Mi4gTmVpdGhlciBjbGFpbSBmaXJlcyBiZWNhdXNlIHRoZVxuICAvLyAgICAgIHVzZXIgaGFzIG5vdCByZXNwb25kZWQgKHBpbnMgQnVnIDIgYmVoYXZpb3IsIHRlc3RlZCBhdCBsaW5lIDI0NCkuXG4gIC8vICAgMi4gVGhlIHVzZXIgcmVzcG9uZHMgTEFURSAoYWZ0ZXIgVDgxL1Q4MiBhbHJlYWR5IGRpc3BhdGNoZWQpLlxuICAvLyAgIDMuIFRoZSB2ZXJ5IG5leHQgcHJvbXB0IGJ1aWxkIChmb3IgVDgzKSBjbGFpbXMgdGhlIG92ZXJyaWRlIGV4YWN0bHlcbiAgLy8gICAgICBvbmNlLiBUODEvVDgyIGFyZSBpbiB0aGUgcGFzdCBcdTIwMTQgdGhleSBtdXN0IG5vdCByZXRyb2FjdGl2ZWx5XG4gIC8vICAgICAgcmVjZWl2ZSB0aGUgaW5qZWN0aW9uIGV2ZW4gdGhvdWdoIHRoZXkgcmFuIGR1cmluZyB0aGUgd2luZG93LlxuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGJhc2UpKTtcbiAgc2VlZENvbXBsZXRlZFRhc2soYmFzZSwgXCJUODBcIik7XG4gIHNlZWRDb21wbGV0ZWRUYXNrKGJhc2UsIFwiVDgxXCIpO1xuICBzZWVkQ29tcGxldGVkVGFzayhiYXNlLCBcIlQ4MlwiKTtcbiAgc2VlZENvbXBsZXRlZFRhc2soYmFzZSwgXCJUODNcIik7XG5cbiAgLy8gUGhhc2UgMSBcdTIwMTQgVDgwIGVzY2FsYXRlcyB3aXRoIGNvbnRpbnVlV2l0aERlZmF1bHQ9dHJ1ZSwgbG9vcCBjb250aW51ZXMuXG4gIHdyaXRlRXNjYWxhdGlvbkFydGlmYWN0KGJhc2UsIGJ1aWxkRXNjYWxhdGlvbkFydGlmYWN0KHtcbiAgICB0YXNrSWQ6IFwiVDgwXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICBxdWVzdGlvbjogXCJXaGljaCBjYWNoZSBzdHJhdGVneT9cIiwgb3B0aW9uczogc2FtcGxlT3B0aW9ucyxcbiAgICByZWNvbW1lbmRhdGlvbjogXCJBXCIsIHJlY29tbWVuZGF0aW9uUmF0aW9uYWxlOiBcIkEgbWF0Y2hlcyBjdXJyZW50IHRlbGVtZXRyeVwiLFxuICAgIGNvbnRpbnVlV2l0aERlZmF1bHQ6IHRydWUsXG4gIH0pKTtcblxuICAvLyBUODAgaXMgYXdhaXRpbmdfcmV2aWV3IChub3QgcGVuZGluZykgXHUyMDE0IHNjaGVkdWxlciBkb2VzIG5vdCBwYXVzZS5cbiAgYXNzZXJ0LmVxdWFsKGdldFRhc2soXCJNMDAxXCIsIFwiUzAxXCIsIFwiVDgwXCIpPy5lc2NhbGF0aW9uX2F3YWl0aW5nX3JldmlldywgMSk7XG4gIGFzc2VydC5lcXVhbChnZXRUYXNrKFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQ4MFwiKT8uZXNjYWxhdGlvbl9wZW5kaW5nLCAwKTtcbiAgYXNzZXJ0LmVxdWFsKGRldGVjdFBlbmRpbmdFc2NhbGF0aW9uKFtnZXRUYXNrKFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQ4MFwiKSFdLCBiYXNlKSwgbnVsbCk7XG5cbiAgLy8gVDgxICsgVDgyIGRpc3BhdGNoIGR1cmluZyB0aGUgcmVzcG9uc2Ugd2luZG93IFx1MjAxNCBuZWl0aGVyIGdldHMgdGhlIGluamVjdGlvbi5cbiAgYXNzZXJ0LmVxdWFsKFxuICAgIGNsYWltT3ZlcnJpZGVGb3JJbmplY3Rpb24oYmFzZSwgXCJNMDAxXCIsIFwiUzAxXCIpLFxuICAgIG51bGwsXG4gICAgXCJUODEncyBwcm9tcHQgYnVpbGQgbXVzdCBub3QgY2xhaW0gdGhlIHVucmVzb2x2ZWQgYXdhaXRpbmdfcmV2aWV3XCIsXG4gICk7XG4gIGFzc2VydC5lcXVhbChcbiAgICBjbGFpbU92ZXJyaWRlRm9ySW5qZWN0aW9uKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiKSxcbiAgICBudWxsLFxuICAgIFwiVDgyJ3MgcHJvbXB0IGJ1aWxkIG11c3QgYWxzbyBub3QgY2xhaW0gdGhlIHVucmVzb2x2ZWQgYXdhaXRpbmdfcmV2aWV3XCIsXG4gICk7XG5cbiAgLy8gVGhlIHJlc3BvbnNlIHdpbmRvdyByZW1haW5zIG9wZW4gYWNyb3NzIE4gdGFza3MgXHUyMDE0IHN0aWxsIG5vIG92ZXJyaWRlIGFwcGxpZWQuXG4gIGFzc2VydC5lcXVhbChcbiAgICBnZXRUYXNrKFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQ4MFwiKT8uZXNjYWxhdGlvbl9vdmVycmlkZV9hcHBsaWVkX2F0LFxuICAgIG51bGwsXG4gICAgXCJhcHBsaWVkX2F0IG11c3Qgc3RheSBudWxsIHRocm91Z2hvdXQgdGhlIHJlc3BvbnNlIHdpbmRvd1wiLFxuICApO1xuXG4gIC8vIFBoYXNlIDIgXHUyMDE0IHVzZXIgcmVzcG9uZHMgTEFURSB3aXRoIGEgZGlmZmVyZW50IG9wdGlvbiB0aGFuIHRoZSByZWNvbW1lbmRhdGlvbi5cbiAgY29uc3QgcmVzb2x2ZVJlc3VsdCA9IHJlc29sdmVFc2NhbGF0aW9uKFxuICAgIGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQ4MFwiLCBcIkJcIiwgXCJhZnRlciByZXZpZXdpbmcsIEIgaXMgdGhlIGNhbGxcIixcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc29sdmVSZXN1bHQuc3RhdHVzLCBcInJlc29sdmVkXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzb2x2ZVJlc3VsdC5jaG9zZW5PcHRpb24/LmlkLCBcIkJcIik7XG5cbiAgLy8gUGhhc2UgMyBcdTIwMTQgdGhlIHZlcnkgbmV4dCBwcm9tcHQgYnVpbGQgKFQ4MykgY2xhaW1zIHRoZSBvdmVycmlkZSBleGFjdGx5IG9uY2UuXG4gIGNvbnN0IGNsYWltZWQgPSBjbGFpbU92ZXJyaWRlRm9ySW5qZWN0aW9uKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiKTtcbiAgYXNzZXJ0Lm9rKGNsYWltZWQsIFwiVDgzJ3MgcHJvbXB0IGJ1aWxkIG11c3QgY2xhaW0gdGhlIGxhdGUtcmVzb2x2ZWQgb3ZlcnJpZGVcIik7XG4gIGFzc2VydC5lcXVhbChjbGFpbWVkIS5zb3VyY2VUYXNrSWQsIFwiVDgwXCIpO1xuICBhc3NlcnQubWF0Y2goY2xhaW1lZCEuaW5qZWN0aW9uQmxvY2ssIC9Fc2NhbGF0aW9uIE92ZXJyaWRlLyk7XG4gIGFzc2VydC5tYXRjaChcbiAgICBjbGFpbWVkIS5pbmplY3Rpb25CbG9jayxcbiAgICAvSlNPTiBhcnJheXxCLyxcbiAgICBcImluamVjdGlvbiBtdXN0IHJlZmxlY3QgdGhlIHVzZXIncyBCIGNob2ljZSwgTk9UIHRoZSBvcmlnaW5hbCBBIHJlY29tbWVuZGF0aW9uXCIsXG4gICk7XG5cbiAgLy8gSWRlbXBvdGVudCBcdTIwMTQgc3Vic2VxdWVudCBwcm9tcHRzIGRvIG5vdCByZS1pbmplY3QuXG4gIGFzc2VydC5lcXVhbChjbGFpbU92ZXJyaWRlRm9ySW5qZWN0aW9uKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiKSwgbnVsbCk7XG59KTtcblxudGVzdChcIkFEUi0wMTEgUDMgIzI1OiBhcnRpZmFjdCB3cml0ZSBmYWlsdXJlIHN1cmZhY2VzLCBsZWF2ZXMgREIgZmxhZ3MgY2xlYW4sIGFuZCByZXRyaWVzIHN1Y2Nlc3NmdWxseSBvbmNlIHJlY292ZXJlZFwiLCBhc3luYyAodCkgPT4ge1xuICAvLyBGYWlsdXJlIG1vZGVzIGNvdmVyZWQ6XG4gIC8vICAgMS4gd3JpdGVFc2NhbGF0aW9uQXJ0aWZhY3Qgd2l0aCBhbiB1bnJlc29sdmFibGUgc2xpY2UgcGF0aCAobm8gc2xpY2VcbiAgLy8gICAgICBkaXIgb24gZGlzaykgdGhyb3dzIHN5bmNocm9ub3VzbHkgXHUyMDE0IG5vIERCIGZsYWcgZmxpcCwgbm8gYXVkaXQuXG4gIC8vICAgMi4gQWZ0ZXIgdGhlIGZsYWcgc3RpbGwgcmVhZHMgMCwgdGhlIGNhbGxlciBjYW4gcmV0cnkgb25jZSB0aGUgZGlyXG4gIC8vICAgICAgZXhpc3RzLiBSZXRyeSBzdWNjZWVkcyBhbmQgYXRvbWljYWxseSBmbGlwcyBlc2NhbGF0aW9uX3BlbmRpbmc9MVxuICAvLyAgICAgIHBsdXMgZW1pdHMgZXhhY3RseSBvbmUgYXVkaXQgZW52ZWxvcGUgKG5vdCB0d28gXHUyMDE0IGlkZW1wb3RlbnRcbiAgLy8gICAgICByZWNvdmVyeSwgbm90IHJlcGxheSkuXG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwOVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlVuc2VlZGVkIHNsaWNlXCIgfSk7XG4gIGluc2VydFRhc2soeyBpZDogXCJUOTBcIiwgc2xpY2VJZDogXCJTMDlcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0pO1xuXG4gIGNvbnN0IGFydGlmYWN0ID0gYnVpbGRFc2NhbGF0aW9uQXJ0aWZhY3Qoe1xuICAgIHRhc2tJZDogXCJUOTBcIiwgc2xpY2VJZDogXCJTMDlcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIHF1ZXN0aW9uOiBcIlFcIiwgb3B0aW9uczogc2FtcGxlT3B0aW9ucywgcmVjb21tZW5kYXRpb246IFwiQVwiLCByZWNvbW1lbmRhdGlvblJhdGlvbmFsZTogXCJyXCIsXG4gICAgY29udGludWVXaXRoRGVmYXVsdDogZmFsc2UsXG4gIH0pO1xuXG4gIC8vIFBoYXNlIDEgXHUyMDE0IHNsaWNlIGRpciBkb2VzIE5PVCBleGlzdCB5ZXQ7IHdyaXRlIG11c3QgdGhyb3cuXG4gIC8vIGVzY2FsYXRpb25BcnRpZmFjdFBhdGggcmV0dXJucyBudWxsLCB3cml0ZUVzY2FsYXRpb25BcnRpZmFjdCB0aHJvd3MuXG4gIGFzc2VydC50aHJvd3MoXG4gICAgKCkgPT4gd3JpdGVFc2NhbGF0aW9uQXJ0aWZhY3QoYmFzZSwgYXJ0aWZhY3QpLFxuICAgIC9jYW5ub3QgcmVzb2x2ZSB0YXNrcyBkaXIvLFxuICAgIFwibWlzc2luZyBzbGljZSBkaXIgbXVzdCByYWlzZSBcdTIwMTQgY2FsbGVyIGlzIGV4cGVjdGVkIHRvIHJ1biBkb2N0b3IgYmVmb3JlIHJldHJ5XCIsXG4gICk7XG5cbiAgLy8gREIgZmxhZyBtdXN0IE5PVCBiZSBzZXQgXHUyMDE0IGF0b21pYyBmYWlsdXJlIHNlbWFudGljcy5cbiAgY29uc3QgbWlkUm93ID0gZ2V0VGFzayhcIk0wMDFcIiwgXCJTMDlcIiwgXCJUOTBcIik7XG4gIGFzc2VydC5lcXVhbChtaWRSb3c/LmVzY2FsYXRpb25fcGVuZGluZywgMCwgXCJmYWlsZWQgd3JpdGUgbXVzdCBsZWF2ZSBlc2NhbGF0aW9uX3BlbmRpbmc9MFwiKTtcbiAgYXNzZXJ0LmVxdWFsKG1pZFJvdz8uZXNjYWxhdGlvbl9hd2FpdGluZ19yZXZpZXcsIDApO1xuICBhc3NlcnQuZXF1YWwobWlkUm93Py5lc2NhbGF0aW9uX2FydGlmYWN0X3BhdGgsIG51bGwpO1xuXG4gIC8vIEF1ZGl0IGxvZyBtdXN0IGhhdmUgbm8gZXNjYWxhdGlvbi1jcmVhdGVkIGV2ZW50cyBmcm9tIHRoZSBmYWlsZWQgd3JpdGUuXG4gIGNvbnN0IGxvZ1BhdGggPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcImF1ZGl0XCIsIFwiZXZlbnRzLmpzb25sXCIpO1xuICBjb25zdCBwcmVMaW5lcyA9IGV4aXN0c1N5bmMobG9nUGF0aClcbiAgICA/IHJlYWRGaWxlU3luYyhsb2dQYXRoLCBcInV0Zi04XCIpLnNwbGl0KFwiXFxuXCIpLmZpbHRlcigobCkgPT4gbC5sZW5ndGggPiAwKVxuICAgIDogW107XG4gIGNvbnN0IHByZUNvdW50ID0gcHJlTGluZXMuZmlsdGVyKChsKSA9PiBsLmluY2x1ZGVzKFwiZXNjYWxhdGlvbi1tYW51YWwtYXR0ZW50aW9uLWNyZWF0ZWRcIikpLmxlbmd0aDtcbiAgYXNzZXJ0LmVxdWFsKHByZUNvdW50LCAwLCBcImZhaWxlZCB3cml0ZSBtdXN0IG5vdCBlbWl0IGFuIGF1ZGl0IGVudmVsb3BlXCIpO1xuXG4gIC8vIFBoYXNlIDIgXHUyMDE0IGNhbGxlciByZWNvdmVycyAoY3JlYXRlcyB0aGUgc2xpY2UgZGlyKSwgcmV0cmllcy5cbiAgLy8gY2xlYXJQYXRoQ2FjaGUoKSBiZWNhdXNlIHJlc29sdmVTbGljZVBhdGggY2FjaGVzIGRpcmVjdG9yeSByZWFkcyBhbmRcbiAgLy8gdGhlIGZpcnN0IGZhaWxlZCBhdHRlbXB0IHBvcHVsYXRlZCBhIG1pc3MgZm9yIFMwOS5cbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDlcIiwgXCJ0YXNrc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IHsgY2xlYXJQYXRoQ2FjaGUgfSA9IGF3YWl0IGltcG9ydChcIi4uL3BhdGhzLnRzXCIpO1xuICBjbGVhclBhdGhDYWNoZSgpO1xuICBjb25zdCBwYXRoID0gd3JpdGVFc2NhbGF0aW9uQXJ0aWZhY3QoYmFzZSwgYXJ0aWZhY3QpO1xuICBhc3NlcnQub2soZXhpc3RzU3luYyhwYXRoKSwgXCJyZXRyeSBtdXN0IGF0b21pY2FsbHkgbGFuZCB0aGUgYXJ0aWZhY3Qgb24gZGlza1wiKTtcblxuICAvLyBEQiBmbGFnIGZsaXBwZWQgb24gc3VjY2Vzc2Z1bCByZXRyeS5cbiAgY29uc3QgYWZ0ZXJSb3cgPSBnZXRUYXNrKFwiTTAwMVwiLCBcIlMwOVwiLCBcIlQ5MFwiKTtcbiAgYXNzZXJ0LmVxdWFsKGFmdGVyUm93Py5lc2NhbGF0aW9uX3BlbmRpbmcsIDEsIFwic3VjY2Vzc2Z1bCByZXRyeSBtdXN0IGZsaXAgZXNjYWxhdGlvbl9wZW5kaW5nPTFcIik7XG4gIGFzc2VydC5lcXVhbChhZnRlclJvdz8uZXNjYWxhdGlvbl9hcnRpZmFjdF9wYXRoLCBwYXRoKTtcblxuICAvLyBBdWRpdCBsb2cgbm93IGNvbnRhaW5zIGV4YWN0bHkgb25lIGVzY2FsYXRpb24tY3JlYXRlZCBldmVudCBmb3IgVDkwLlxuICBjb25zdCBwb3N0TGluZXMgPSByZWFkRmlsZVN5bmMobG9nUGF0aCwgXCJ1dGYtOFwiKS5zcGxpdChcIlxcblwiKS5maWx0ZXIoKGwpID0+IGwubGVuZ3RoID4gMCk7XG4gIGNvbnN0IHQ5MEV2ZW50cyA9IHBvc3RMaW5lc1xuICAgIC5tYXAoKGwpID0+IEpTT04ucGFyc2UobCkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pXG4gICAgLmZpbHRlcigoZSkgPT5cbiAgICAgIGVbXCJ0eXBlXCJdID09PSBcImVzY2FsYXRpb24tbWFudWFsLWF0dGVudGlvbi1jcmVhdGVkXCJcbiAgICAgICYmIChlW1wicGF5bG9hZFwiXSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik/LltcInRhc2tJZFwiXSA9PT0gXCJUOTBcIixcbiAgICApO1xuICBhc3NlcnQuZXF1YWwodDkwRXZlbnRzLmxlbmd0aCwgMSwgXCJzdWNjZXNzZnVsIHJldHJ5IG11c3QgZW1pdCBleGFjdGx5IG9uZSBhdWRpdCBlbnZlbG9wZVwiKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBSUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxRQUFRLGVBQWUsWUFBWSxvQkFBb0I7QUFDeEYsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFF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
