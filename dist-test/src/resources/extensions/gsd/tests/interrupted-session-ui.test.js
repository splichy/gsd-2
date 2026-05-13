import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { assessInterruptedSession } from "../interrupted-session.js";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  _getAdapter
} from "../gsd-db.js";
import { registerAutoWorker } from "../db/auto-workers.js";
import { claimMilestoneLease } from "../db/milestone-leases.js";
import { recordDispatchClaim } from "../db/unit-dispatches.js";
import { setRuntimeKv } from "../db/runtime-kv.js";
import {
  PAUSED_SESSION_KV_KEY
} from "../interrupted-session.js";
import { normalizeRealPath } from "../paths.js";
function makeTmpBase() {
  const base = join(tmpdir(), `gsd-smart-entry-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
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
function openFixtureDb(base) {
  openDatabase(join(base, ".gsd", "gsd.db"));
}
function expireWorker(workerId) {
  const db = _getAdapter();
  db.prepare(
    `UPDATE workers SET last_heartbeat_at = '1970-01-01T00:00:00.000Z' WHERE worker_id = :worker_id`
  ).run({ ":worker_id": workerId });
}
function writePausedSession(base, milestoneId = "M001", stepMode = false) {
  openFixtureDb(base);
  const meta = {
    milestoneId,
    originalBasePath: base,
    stepMode
  };
  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, meta);
}
function writeLock(base, unitType, unitId) {
  openFixtureDb(base);
  insertMilestone({
    id: "M001",
    title: "Test Milestone",
    status: unitType === "complete-slice" ? "complete" : "active"
  });
  const workerId = registerAutoWorker({ projectRootRealpath: normalizeRealPath(base) });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true);
  if (lease.ok) {
    const [, sliceId = null, taskId = null] = unitId.split("/");
    const claimed = recordDispatchClaim({
      traceId: `trace-${randomUUID().slice(0, 8)}`,
      workerId,
      milestoneLeaseToken: lease.token,
      milestoneId: "M001",
      sliceId,
      taskId,
      unitType,
      unitId
    });
    assert.equal(claimed.ok, true);
  }
  _getAdapter().prepare(`UPDATE workers SET pid = 99999 WHERE worker_id = :worker_id`).run({ ":worker_id": workerId });
  expireWorker(workerId);
}
function writeRoadmap(base, checked = false) {
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(join(milestoneDir, "slices", "S01", "tasks"), { recursive: true });
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Test Milestone",
      "",
      "## Vision",
      "",
      "Test milestone.",
      "",
      "## Success Criteria",
      "",
      "- It works.",
      "",
      "## Slices",
      "",
      `- [${checked ? "x" : " "}] **S01: Test slice** \`risk:low\``,
      "  After this: Demo",
      "",
      "## Boundary Map",
      "",
      "- S01 \u2192 terminal",
      "  - Produces: done",
      "  - Consumes: nothing"
    ].join("\n"),
    "utf-8"
  );
}
function writeCompleteArtifacts(base) {
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(sliceDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(sliceDir, "S01-PLAN.md"), "# S01: Test Slice\n\n## Tasks\n- [x] **T01: Do thing** `est:10m`\n", "utf-8");
  writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "# Task Summary\nDone.\n", "utf-8");
  writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\nDone.\n", "utf-8");
  writeFileSync(join(sliceDir, "S01-UAT.md"), "# UAT\nPassed.\n", "utf-8");
  writeFileSync(join(milestoneDir, "M001-SUMMARY.md"), "# Milestone Summary\nDone.\n", "utf-8");
}
test("guided-flow stale complete scenario classifies as stale so the resume prompt can be suppressed", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, true);
    writeCompleteArtifacts(base);
    writeLock(base, "complete-slice", "M001/S01");
    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "stale");
    assert.equal(assessment.recoveryPrompt, null);
  } finally {
    cleanup(base);
  }
});
test("guided-flow paused-session scenario classifies as recoverable so resume remains available", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, false);
    writePausedSession(base);
    writeLock(base, "execute-task", "M001/S01/T01");
    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "recoverable");
    assert.equal(assessment.pausedSession?.milestoneId, "M001");
  } finally {
    cleanup(base);
  }
});
test("guided-flow stale paused-session scenario is suppressed when no resumable work remains", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, true);
    writeCompleteArtifacts(base);
    writePausedSession(base, "M999", true);
    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "stale");
    assert.equal(assessment.hasResumableDiskState, false);
  } finally {
    cleanup(base);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9pbnRlcnJ1cHRlZC1zZXNzaW9uLXVpLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5cbmltcG9ydCB7IGFzc2Vzc0ludGVycnVwdGVkU2Vzc2lvbiB9IGZyb20gXCIuLi9pbnRlcnJ1cHRlZC1zZXNzaW9uLnRzXCI7XG5pbXBvcnQge1xuICBvcGVuRGF0YWJhc2UsXG4gIGNsb3NlRGF0YWJhc2UsXG4gIGluc2VydE1pbGVzdG9uZSxcbiAgX2dldEFkYXB0ZXIsXG59IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcbmltcG9ydCB7IHJlZ2lzdGVyQXV0b1dvcmtlciB9IGZyb20gXCIuLi9kYi9hdXRvLXdvcmtlcnMudHNcIjtcbmltcG9ydCB7IGNsYWltTWlsZXN0b25lTGVhc2UgfSBmcm9tIFwiLi4vZGIvbWlsZXN0b25lLWxlYXNlcy50c1wiO1xuaW1wb3J0IHsgcmVjb3JkRGlzcGF0Y2hDbGFpbSB9IGZyb20gXCIuLi9kYi91bml0LWRpc3BhdGNoZXMudHNcIjtcbmltcG9ydCB7IHNldFJ1bnRpbWVLdiB9IGZyb20gXCIuLi9kYi9ydW50aW1lLWt2LnRzXCI7XG5pbXBvcnQge1xuICBQQVVTRURfU0VTU0lPTl9LVl9LRVksXG4gIHR5cGUgUGF1c2VkU2Vzc2lvbk1ldGFkYXRhLFxufSBmcm9tIFwiLi4vaW50ZXJydXB0ZWQtc2Vzc2lvbi50c1wiO1xuaW1wb3J0IHsgbm9ybWFsaXplUmVhbFBhdGggfSBmcm9tIFwiLi4vcGF0aHMudHNcIjtcblxuZnVuY3Rpb24gbWFrZVRtcEJhc2UoKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IGpvaW4odG1wZGlyKCksIGBnc2Qtc21hcnQtZW50cnktJHtyYW5kb21VVUlEKCl9YCk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5mdW5jdGlvbiBjbGVhbnVwKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICB0cnkgeyBjbG9zZURhdGFiYXNlKCk7IH0gY2F0Y2ggeyAvKiAqLyB9XG4gIHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2ggeyAvKiAqLyB9XG59XG5cbmZ1bmN0aW9uIG9wZW5GaXh0dXJlRGIoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG59XG5cbmZ1bmN0aW9uIGV4cGlyZVdvcmtlcih3b3JrZXJJZDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGRiID0gX2dldEFkYXB0ZXIoKSE7XG4gIGRiLnByZXBhcmUoXG4gICAgYFVQREFURSB3b3JrZXJzIFNFVCBsYXN0X2hlYXJ0YmVhdF9hdCA9ICcxOTcwLTAxLTAxVDAwOjAwOjAwLjAwMFonIFdIRVJFIHdvcmtlcl9pZCA9IDp3b3JrZXJfaWRgLFxuICApLnJ1bih7IFwiOndvcmtlcl9pZFwiOiB3b3JrZXJJZCB9KTtcbn1cblxuZnVuY3Rpb24gd3JpdGVQYXVzZWRTZXNzaW9uKGJhc2U6IHN0cmluZywgbWlsZXN0b25lSWQgPSBcIk0wMDFcIiwgc3RlcE1vZGUgPSBmYWxzZSk6IHZvaWQge1xuICBvcGVuRml4dHVyZURiKGJhc2UpO1xuICBjb25zdCBtZXRhOiBQYXVzZWRTZXNzaW9uTWV0YWRhdGEgPSB7XG4gICAgbWlsZXN0b25lSWQsXG4gICAgb3JpZ2luYWxCYXNlUGF0aDogYmFzZSxcbiAgICBzdGVwTW9kZSxcbiAgfTtcbiAgc2V0UnVudGltZUt2KFwiZ2xvYmFsXCIsIFwiXCIsIFBBVVNFRF9TRVNTSU9OX0tWX0tFWSwgbWV0YSk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlTG9jayhiYXNlOiBzdHJpbmcsIHVuaXRUeXBlOiBzdHJpbmcsIHVuaXRJZDogc3RyaW5nKTogdm9pZCB7XG4gIG9wZW5GaXh0dXJlRGIoYmFzZSk7XG4gIGluc2VydE1pbGVzdG9uZSh7XG4gICAgaWQ6IFwiTTAwMVwiLFxuICAgIHRpdGxlOiBcIlRlc3QgTWlsZXN0b25lXCIsXG4gICAgc3RhdHVzOiB1bml0VHlwZSA9PT0gXCJjb21wbGV0ZS1zbGljZVwiID8gXCJjb21wbGV0ZVwiIDogXCJhY3RpdmVcIixcbiAgfSk7XG4gIGNvbnN0IHdvcmtlcklkID0gcmVnaXN0ZXJBdXRvV29ya2VyKHsgcHJvamVjdFJvb3RSZWFscGF0aDogbm9ybWFsaXplUmVhbFBhdGgoYmFzZSkgfSk7XG4gIGNvbnN0IGxlYXNlID0gY2xhaW1NaWxlc3RvbmVMZWFzZSh3b3JrZXJJZCwgXCJNMDAxXCIpO1xuICBhc3NlcnQuZXF1YWwobGVhc2Uub2ssIHRydWUpO1xuICBpZiAobGVhc2Uub2spIHtcbiAgICBjb25zdCBbLCBzbGljZUlkID0gbnVsbCwgdGFza0lkID0gbnVsbF0gPSB1bml0SWQuc3BsaXQoXCIvXCIpO1xuICAgIGNvbnN0IGNsYWltZWQgPSByZWNvcmREaXNwYXRjaENsYWltKHtcbiAgICAgIHRyYWNlSWQ6IGB0cmFjZS0ke3JhbmRvbVVVSUQoKS5zbGljZSgwLCA4KX1gLFxuICAgICAgd29ya2VySWQsXG4gICAgICBtaWxlc3RvbmVMZWFzZVRva2VuOiBsZWFzZS50b2tlbixcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIHNsaWNlSWQsXG4gICAgICB0YXNrSWQsXG4gICAgICB1bml0VHlwZSxcbiAgICAgIHVuaXRJZCxcbiAgICB9KTtcbiAgICBhc3NlcnQuZXF1YWwoY2xhaW1lZC5vaywgdHJ1ZSk7XG4gIH1cbiAgX2dldEFkYXB0ZXIoKSFcbiAgICAucHJlcGFyZShgVVBEQVRFIHdvcmtlcnMgU0VUIHBpZCA9IDk5OTk5IFdIRVJFIHdvcmtlcl9pZCA9IDp3b3JrZXJfaWRgKVxuICAgIC5ydW4oeyBcIjp3b3JrZXJfaWRcIjogd29ya2VySWQgfSk7XG4gIGV4cGlyZVdvcmtlcih3b3JrZXJJZCk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlUm9hZG1hcChiYXNlOiBzdHJpbmcsIGNoZWNrZWQgPSBmYWxzZSk6IHZvaWQge1xuICBjb25zdCBtaWxlc3RvbmVEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpO1xuICBta2RpclN5bmMoam9pbihtaWxlc3RvbmVEaXIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwidGFza3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4obWlsZXN0b25lRGlyLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSxcbiAgICBbXG4gICAgICBcIiMgTTAwMTogVGVzdCBNaWxlc3RvbmVcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFZpc2lvblwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiVGVzdCBtaWxlc3RvbmUuXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBTdWNjZXNzIENyaXRlcmlhXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCItIEl0IHdvcmtzLlwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgU2xpY2VzXCIsXG4gICAgICBcIlwiLFxuICAgICAgYC0gWyR7Y2hlY2tlZCA/IFwieFwiIDogXCIgXCJ9XSAqKlMwMTogVGVzdCBzbGljZSoqIFxcYHJpc2s6bG93XFxgYCxcbiAgICAgIFwiICBBZnRlciB0aGlzOiBEZW1vXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBCb3VuZGFyeSBNYXBcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIi0gUzAxIFx1MjE5MiB0ZXJtaW5hbFwiLFxuICAgICAgXCIgIC0gUHJvZHVjZXM6IGRvbmVcIixcbiAgICAgIFwiICAtIENvbnN1bWVzOiBub3RoaW5nXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpLFxuICAgIFwidXRmLThcIixcbiAgKTtcbn1cblxuZnVuY3Rpb24gd3JpdGVDb21wbGV0ZUFydGlmYWN0cyhiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgbWlsZXN0b25lRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKTtcbiAgY29uc3Qgc2xpY2VEaXIgPSBqb2luKG1pbGVzdG9uZURpciwgXCJzbGljZXNcIiwgXCJTMDFcIik7XG4gIGNvbnN0IHRhc2tzRGlyID0gam9pbihzbGljZURpciwgXCJ0YXNrc1wiKTtcbiAgbWtkaXJTeW5jKHNsaWNlRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgbWtkaXJTeW5jKHRhc2tzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKHNsaWNlRGlyLCBcIlMwMS1QTEFOLm1kXCIpLCBcIiMgUzAxOiBUZXN0IFNsaWNlXFxuXFxuIyMgVGFza3NcXG4tIFt4XSAqKlQwMTogRG8gdGhpbmcqKiBgZXN0OjEwbWBcXG5cIiwgXCJ1dGYtOFwiKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKHRhc2tzRGlyLCBcIlQwMS1TVU1NQVJZLm1kXCIpLCBcIiMgVGFzayBTdW1tYXJ5XFxuRG9uZS5cXG5cIiwgXCJ1dGYtOFwiKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKHNsaWNlRGlyLCBcIlMwMS1TVU1NQVJZLm1kXCIpLCBcIiMgU3VtbWFyeVxcbkRvbmUuXFxuXCIsIFwidXRmLThcIik7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihzbGljZURpciwgXCJTMDEtVUFULm1kXCIpLCBcIiMgVUFUXFxuUGFzc2VkLlxcblwiLCBcInV0Zi04XCIpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4obWlsZXN0b25lRGlyLCBcIk0wMDEtU1VNTUFSWS5tZFwiKSwgXCIjIE1pbGVzdG9uZSBTdW1tYXJ5XFxuRG9uZS5cXG5cIiwgXCJ1dGYtOFwiKTtcbn1cblxudGVzdChcImd1aWRlZC1mbG93IHN0YWxlIGNvbXBsZXRlIHNjZW5hcmlvIGNsYXNzaWZpZXMgYXMgc3RhbGUgc28gdGhlIHJlc3VtZSBwcm9tcHQgY2FuIGJlIHN1cHByZXNzZWRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICB3cml0ZVJvYWRtYXAoYmFzZSwgdHJ1ZSk7XG4gICAgd3JpdGVDb21wbGV0ZUFydGlmYWN0cyhiYXNlKTtcbiAgICB3cml0ZUxvY2soYmFzZSwgXCJjb21wbGV0ZS1zbGljZVwiLCBcIk0wMDEvUzAxXCIpO1xuXG4gICAgY29uc3QgYXNzZXNzbWVudCA9IGF3YWl0IGFzc2Vzc0ludGVycnVwdGVkU2Vzc2lvbihiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwoYXNzZXNzbWVudC5jbGFzc2lmaWNhdGlvbiwgXCJzdGFsZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoYXNzZXNzbWVudC5yZWNvdmVyeVByb21wdCwgbnVsbCk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJndWlkZWQtZmxvdyBwYXVzZWQtc2Vzc2lvbiBzY2VuYXJpbyBjbGFzc2lmaWVzIGFzIHJlY292ZXJhYmxlIHNvIHJlc3VtZSByZW1haW5zIGF2YWlsYWJsZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlUm9hZG1hcChiYXNlLCBmYWxzZSk7XG4gICAgd3JpdGVQYXVzZWRTZXNzaW9uKGJhc2UpO1xuICAgIHdyaXRlTG9jayhiYXNlLCBcImV4ZWN1dGUtdGFza1wiLCBcIk0wMDEvUzAxL1QwMVwiKTtcblxuICAgIGNvbnN0IGFzc2Vzc21lbnQgPSBhd2FpdCBhc3Nlc3NJbnRlcnJ1cHRlZFNlc3Npb24oYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGFzc2Vzc21lbnQuY2xhc3NpZmljYXRpb24sIFwicmVjb3ZlcmFibGVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGFzc2Vzc21lbnQucGF1c2VkU2Vzc2lvbj8ubWlsZXN0b25lSWQsIFwiTTAwMVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImd1aWRlZC1mbG93IHN0YWxlIHBhdXNlZC1zZXNzaW9uIHNjZW5hcmlvIGlzIHN1cHByZXNzZWQgd2hlbiBubyByZXN1bWFibGUgd29yayByZW1haW5zXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVSb2FkbWFwKGJhc2UsIHRydWUpO1xuICAgIHdyaXRlQ29tcGxldGVBcnRpZmFjdHMoYmFzZSk7XG4gICAgd3JpdGVQYXVzZWRTZXNzaW9uKGJhc2UsIFwiTTk5OVwiLCB0cnVlKTtcblxuICAgIGNvbnN0IGFzc2Vzc21lbnQgPSBhd2FpdCBhc3Nlc3NJbnRlcnJ1cHRlZFNlc3Npb24oYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGFzc2Vzc21lbnQuY2xhc3NpZmljYXRpb24sIFwic3RhbGVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGFzc2Vzc21lbnQuaGFzUmVzdW1hYmxlRGlza1N0YXRlLCBmYWxzZSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbi8vIE5vdGU6IHRoZSBwcmlvciBzb3VyY2UtZ3JlcCB0ZXN0IHRoYXQgc2Nhbm5lZCBndWlkZWQtZmxvdy50cyBmb3IgZml2ZVxuLy8gc3RyaW5nIGxpdGVyYWxzIHdhcyByZW1vdmVkIHVuZGVyICM0ODI3LiBUaGUgaW52YXJpYW50cyBpdCBlbmNvZGVkXG4vLyAoc3RlcC1hd2FyZSByZXN1bWUgKyBzdGFsZSBwYXVzZWQtc2Vzc2lvbiBjbGVhbnVwICsgcGVuZGluZ0F1dG9TdGFydE1hcFxuLy8gc2lkZSBlZmZlY3QpIHNob3VsZCBiZSBjb3ZlcmVkIGJ5IGEgcnVudGltZSBkcml2ZSBvZiBndWlkZWQtZmxvdyBcdTIwMTRcbi8vIHRyYWNrZWQgYXMgYSBmb2xsb3ctdXAuXG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsV0FBVyxRQUFRLHFCQUFxQjtBQUNqRCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsa0JBQWtCO0FBRTNCLFNBQVMsZ0NBQWdDO0FBQ3pDO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLDBCQUEwQjtBQUNuQyxTQUFTLDJCQUEyQjtBQUNwQyxTQUFTLDJCQUEyQjtBQUNwQyxTQUFTLG9CQUFvQjtBQUM3QjtBQUFBLEVBQ0U7QUFBQSxPQUVLO0FBQ1AsU0FBUyx5QkFBeUI7QUFFbEMsU0FBUyxjQUFzQjtBQUM3QixRQUFNLE9BQU8sS0FBSyxPQUFPLEdBQUcsbUJBQW1CLFdBQVcsQ0FBQyxFQUFFO0FBQzdELFlBQVUsS0FBSyxNQUFNLE1BQU0sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2pELFNBQU87QUFDVDtBQUVBLFNBQVMsUUFBUSxNQUFvQjtBQUNuQyxNQUFJO0FBQUUsa0JBQWM7QUFBQSxFQUFHLFFBQVE7QUFBQSxFQUFRO0FBQ3ZDLE1BQUk7QUFBRSxXQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUFHLFFBQVE7QUFBQSxFQUFRO0FBQ3hFO0FBRUEsU0FBUyxjQUFjLE1BQW9CO0FBQ3pDLGVBQWEsS0FBSyxNQUFNLFFBQVEsUUFBUSxDQUFDO0FBQzNDO0FBRUEsU0FBUyxhQUFhLFVBQXdCO0FBQzVDLFFBQU0sS0FBSyxZ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
