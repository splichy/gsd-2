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
  const base = join(tmpdir(), `gsd-auto-interrupted-${randomUUID()}`);
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
function writePausedSession(base, milestoneId = "M001", stepMode = false) {
  openFixtureDb(base);
  const meta = {
    milestoneId,
    originalBasePath: base,
    stepMode
  };
  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, meta);
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
test("direct /gsd auto stale complete repo yields stale classification with no recovery payload", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, true);
    writeCompleteArtifacts(base);
    writeLock(base, "complete-slice", "M001/S01");
    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "stale");
    assert.equal(assessment.recoveryPrompt, null);
    assert.equal(assessment.hasResumableDiskState, false);
  } finally {
    cleanup(base);
  }
});
test("direct /gsd auto paused-session metadata remains recoverable when work is unfinished", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, false);
    writePausedSession(base, "M001", false);
    writeLock(base, "execute-task", "M001/S01/T01");
    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "recoverable");
    assert.equal(assessment.pausedSession?.milestoneId, "M001");
  } finally {
    cleanup(base);
  }
});
test("direct /gsd auto stale paused-session metadata is treated as stale when no resumable work remains", async () => {
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
test("direct /gsd auto source only resumes paused-session metadata for recoverable state with real recovery signals", async () => {
  const source = await import("node:fs/promises").then(
    (fs) => fs.readFile(new URL("../auto.ts", import.meta.url), "utf-8")
  );
  assert.ok(source.includes("const shouldResumePausedSession ="));
  assert.ok(source.includes('freshStartAssessment.classification === "recoverable"'));
  assert.ok(source.includes("&& ("));
  assert.ok(source.includes("freshStartAssessment.hasResumableDiskState"));
  assert.ok(source.includes("|| !!freshStartAssessment.recoveryPrompt"));
  assert.ok(source.includes("|| !!freshStartAssessment.lock"));
});
test("auto module imports successfully after interrupted-session changes", async () => {
  const mod = await import(`../auto.ts?ts=${Date.now()}-${Math.random()}`);
  assert.equal(typeof mod.startAuto, "function");
  assert.equal(typeof mod.pauseAuto, "function");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9pbnRlcnJ1cHRlZC1zZXNzaW9uLWF1dG8udGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcblxuaW1wb3J0IHsgYXNzZXNzSW50ZXJydXB0ZWRTZXNzaW9uIH0gZnJvbSBcIi4uL2ludGVycnVwdGVkLXNlc3Npb24udHNcIjtcbmltcG9ydCB7XG4gIG9wZW5EYXRhYmFzZSxcbiAgY2xvc2VEYXRhYmFzZSxcbiAgaW5zZXJ0TWlsZXN0b25lLFxuICBfZ2V0QWRhcHRlcixcbn0gZnJvbSBcIi4uL2dzZC1kYi50c1wiO1xuaW1wb3J0IHsgcmVnaXN0ZXJBdXRvV29ya2VyIH0gZnJvbSBcIi4uL2RiL2F1dG8td29ya2Vycy50c1wiO1xuaW1wb3J0IHsgY2xhaW1NaWxlc3RvbmVMZWFzZSB9IGZyb20gXCIuLi9kYi9taWxlc3RvbmUtbGVhc2VzLnRzXCI7XG5pbXBvcnQgeyByZWNvcmREaXNwYXRjaENsYWltIH0gZnJvbSBcIi4uL2RiL3VuaXQtZGlzcGF0Y2hlcy50c1wiO1xuaW1wb3J0IHsgc2V0UnVudGltZUt2IH0gZnJvbSBcIi4uL2RiL3J1bnRpbWUta3YudHNcIjtcbmltcG9ydCB7XG4gIFBBVVNFRF9TRVNTSU9OX0tWX0tFWSxcbiAgdHlwZSBQYXVzZWRTZXNzaW9uTWV0YWRhdGEsXG59IGZyb20gXCIuLi9pbnRlcnJ1cHRlZC1zZXNzaW9uLnRzXCI7XG5pbXBvcnQgeyBub3JtYWxpemVSZWFsUGF0aCB9IGZyb20gXCIuLi9wYXRocy50c1wiO1xuXG5mdW5jdGlvbiBtYWtlVG1wQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gam9pbih0bXBkaXIoKSwgYGdzZC1hdXRvLWludGVycnVwdGVkLSR7cmFuZG9tVVVJRCgpfWApO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gY2xlYW51cChiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHsgY2xvc2VEYXRhYmFzZSgpOyB9IGNhdGNoIHsgLyogKi8gfVxuICB0cnkgeyBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHsgLyogKi8gfVxufVxuXG5mdW5jdGlvbiBvcGVuRml4dHVyZURiKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xufVxuXG5mdW5jdGlvbiBleHBpcmVXb3JrZXIod29ya2VySWQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBkYiA9IF9nZXRBZGFwdGVyKCkhO1xuICBkYi5wcmVwYXJlKFxuICAgIGBVUERBVEUgd29ya2VycyBTRVQgbGFzdF9oZWFydGJlYXRfYXQgPSAnMTk3MC0wMS0wMVQwMDowMDowMC4wMDBaJyBXSEVSRSB3b3JrZXJfaWQgPSA6d29ya2VyX2lkYCxcbiAgKS5ydW4oeyBcIjp3b3JrZXJfaWRcIjogd29ya2VySWQgfSk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlTG9jayhiYXNlOiBzdHJpbmcsIHVuaXRUeXBlOiBzdHJpbmcsIHVuaXRJZDogc3RyaW5nKTogdm9pZCB7XG4gIG9wZW5GaXh0dXJlRGIoYmFzZSk7XG4gIGluc2VydE1pbGVzdG9uZSh7XG4gICAgaWQ6IFwiTTAwMVwiLFxuICAgIHRpdGxlOiBcIlRlc3QgTWlsZXN0b25lXCIsXG4gICAgc3RhdHVzOiB1bml0VHlwZSA9PT0gXCJjb21wbGV0ZS1zbGljZVwiID8gXCJjb21wbGV0ZVwiIDogXCJhY3RpdmVcIixcbiAgfSk7XG4gIGNvbnN0IHdvcmtlcklkID0gcmVnaXN0ZXJBdXRvV29ya2VyKHsgcHJvamVjdFJvb3RSZWFscGF0aDogbm9ybWFsaXplUmVhbFBhdGgoYmFzZSkgfSk7XG4gIGNvbnN0IGxlYXNlID0gY2xhaW1NaWxlc3RvbmVMZWFzZSh3b3JrZXJJZCwgXCJNMDAxXCIpO1xuICBhc3NlcnQuZXF1YWwobGVhc2Uub2ssIHRydWUpO1xuICBpZiAobGVhc2Uub2spIHtcbiAgICBjb25zdCBbLCBzbGljZUlkID0gbnVsbCwgdGFza0lkID0gbnVsbF0gPSB1bml0SWQuc3BsaXQoXCIvXCIpO1xuICAgIGNvbnN0IGNsYWltZWQgPSByZWNvcmREaXNwYXRjaENsYWltKHtcbiAgICAgIHRyYWNlSWQ6IGB0cmFjZS0ke3JhbmRvbVVVSUQoKS5zbGljZSgwLCA4KX1gLFxuICAgICAgd29ya2VySWQsXG4gICAgICBtaWxlc3RvbmVMZWFzZVRva2VuOiBsZWFzZS50b2tlbixcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIHNsaWNlSWQsXG4gICAgICB0YXNrSWQsXG4gICAgICB1bml0VHlwZSxcbiAgICAgIHVuaXRJZCxcbiAgICB9KTtcbiAgICBhc3NlcnQuZXF1YWwoY2xhaW1lZC5vaywgdHJ1ZSk7XG4gIH1cbiAgX2dldEFkYXB0ZXIoKSFcbiAgICAucHJlcGFyZShgVVBEQVRFIHdvcmtlcnMgU0VUIHBpZCA9IDk5OTk5IFdIRVJFIHdvcmtlcl9pZCA9IDp3b3JrZXJfaWRgKVxuICAgIC5ydW4oeyBcIjp3b3JrZXJfaWRcIjogd29ya2VySWQgfSk7XG4gIGV4cGlyZVdvcmtlcih3b3JrZXJJZCk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlUGF1c2VkU2Vzc2lvbihiYXNlOiBzdHJpbmcsIG1pbGVzdG9uZUlkID0gXCJNMDAxXCIsIHN0ZXBNb2RlID0gZmFsc2UpOiB2b2lkIHtcbiAgb3BlbkZpeHR1cmVEYihiYXNlKTtcbiAgY29uc3QgbWV0YTogUGF1c2VkU2Vzc2lvbk1ldGFkYXRhID0ge1xuICAgIG1pbGVzdG9uZUlkLFxuICAgIG9yaWdpbmFsQmFzZVBhdGg6IGJhc2UsXG4gICAgc3RlcE1vZGUsXG4gIH07XG4gIHNldFJ1bnRpbWVLdihcImdsb2JhbFwiLCBcIlwiLCBQQVVTRURfU0VTU0lPTl9LVl9LRVksIG1ldGEpO1xufVxuXG5mdW5jdGlvbiB3cml0ZVJvYWRtYXAoYmFzZTogc3RyaW5nLCBjaGVja2VkID0gZmFsc2UpOiB2b2lkIHtcbiAgY29uc3QgbWlsZXN0b25lRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKTtcbiAgbWtkaXJTeW5jKGpvaW4obWlsZXN0b25lRGlyLCBcInNsaWNlc1wiLCBcIlMwMVwiLCBcInRhc2tzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKG1pbGVzdG9uZURpciwgXCJNMDAxLVJPQURNQVAubWRcIiksXG4gICAgW1xuICAgICAgXCIjIE0wMDE6IFRlc3QgTWlsZXN0b25lXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBWaXNpb25cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIlRlc3QgbWlsZXN0b25lLlwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgU3VjY2VzcyBDcml0ZXJpYVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiLSBJdCB3b3Jrcy5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFNsaWNlc1wiLFxuICAgICAgXCJcIixcbiAgICAgIGAtIFske2NoZWNrZWQgPyBcInhcIiA6IFwiIFwifV0gKipTMDE6IFRlc3Qgc2xpY2UqKiBcXGByaXNrOmxvd1xcYGAsXG4gICAgICBcIiAgQWZ0ZXIgdGhpczogRGVtb1wiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgQm91bmRhcnkgTWFwXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCItIFMwMSBcdTIxOTIgdGVybWluYWxcIixcbiAgICAgIFwiICAtIFByb2R1Y2VzOiBkb25lXCIsXG4gICAgICBcIiAgLSBDb25zdW1lczogbm90aGluZ1wiLFxuICAgIF0uam9pbihcIlxcblwiKSxcbiAgICBcInV0Zi04XCIsXG4gICk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlQ29tcGxldGVBcnRpZmFjdHMoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IG1pbGVzdG9uZURpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIik7XG4gIGNvbnN0IHNsaWNlRGlyID0gam9pbihtaWxlc3RvbmVEaXIsIFwic2xpY2VzXCIsIFwiUzAxXCIpO1xuICBjb25zdCB0YXNrc0RpciA9IGpvaW4oc2xpY2VEaXIsIFwidGFza3NcIik7XG4gIG1rZGlyU3luYyhzbGljZURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIG1rZGlyU3luYyh0YXNrc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihzbGljZURpciwgXCJTMDEtUExBTi5tZFwiKSwgXCIjIFMwMTogVGVzdCBTbGljZVxcblxcbiMjIFRhc2tzXFxuLSBbeF0gKipUMDE6IERvIHRoaW5nKiogYGVzdDoxMG1gXFxuXCIsIFwidXRmLThcIik7XG4gIHdyaXRlRmlsZVN5bmMoam9pbih0YXNrc0RpciwgXCJUMDEtU1VNTUFSWS5tZFwiKSwgXCIjIFRhc2sgU3VtbWFyeVxcbkRvbmUuXFxuXCIsIFwidXRmLThcIik7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihzbGljZURpciwgXCJTMDEtU1VNTUFSWS5tZFwiKSwgXCIjIFN1bW1hcnlcXG5Eb25lLlxcblwiLCBcInV0Zi04XCIpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oc2xpY2VEaXIsIFwiUzAxLVVBVC5tZFwiKSwgXCIjIFVBVFxcblBhc3NlZC5cXG5cIiwgXCJ1dGYtOFwiKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKG1pbGVzdG9uZURpciwgXCJNMDAxLVNVTU1BUlkubWRcIiksIFwiIyBNaWxlc3RvbmUgU3VtbWFyeVxcbkRvbmUuXFxuXCIsIFwidXRmLThcIik7XG59XG5cbnRlc3QoXCJkaXJlY3QgL2dzZCBhdXRvIHN0YWxlIGNvbXBsZXRlIHJlcG8geWllbGRzIHN0YWxlIGNsYXNzaWZpY2F0aW9uIHdpdGggbm8gcmVjb3ZlcnkgcGF5bG9hZFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlUm9hZG1hcChiYXNlLCB0cnVlKTtcbiAgICB3cml0ZUNvbXBsZXRlQXJ0aWZhY3RzKGJhc2UpO1xuICAgIHdyaXRlTG9jayhiYXNlLCBcImNvbXBsZXRlLXNsaWNlXCIsIFwiTTAwMS9TMDFcIik7XG5cbiAgICBjb25zdCBhc3Nlc3NtZW50ID0gYXdhaXQgYXNzZXNzSW50ZXJydXB0ZWRTZXNzaW9uKGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChhc3Nlc3NtZW50LmNsYXNzaWZpY2F0aW9uLCBcInN0YWxlXCIpO1xuICAgIGFzc2VydC5lcXVhbChhc3Nlc3NtZW50LnJlY292ZXJ5UHJvbXB0LCBudWxsKTtcbiAgICBhc3NlcnQuZXF1YWwoYXNzZXNzbWVudC5oYXNSZXN1bWFibGVEaXNrU3RhdGUsIGZhbHNlKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImRpcmVjdCAvZ3NkIGF1dG8gcGF1c2VkLXNlc3Npb24gbWV0YWRhdGEgcmVtYWlucyByZWNvdmVyYWJsZSB3aGVuIHdvcmsgaXMgdW5maW5pc2hlZFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlUm9hZG1hcChiYXNlLCBmYWxzZSk7XG4gICAgd3JpdGVQYXVzZWRTZXNzaW9uKGJhc2UsIFwiTTAwMVwiLCBmYWxzZSk7XG4gICAgd3JpdGVMb2NrKGJhc2UsIFwiZXhlY3V0ZS10YXNrXCIsIFwiTTAwMS9TMDEvVDAxXCIpO1xuXG4gICAgY29uc3QgYXNzZXNzbWVudCA9IGF3YWl0IGFzc2Vzc0ludGVycnVwdGVkU2Vzc2lvbihiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwoYXNzZXNzbWVudC5jbGFzc2lmaWNhdGlvbiwgXCJyZWNvdmVyYWJsZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoYXNzZXNzbWVudC5wYXVzZWRTZXNzaW9uPy5taWxlc3RvbmVJZCwgXCJNMDAxXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGlyZWN0IC9nc2QgYXV0byBzdGFsZSBwYXVzZWQtc2Vzc2lvbiBtZXRhZGF0YSBpcyB0cmVhdGVkIGFzIHN0YWxlIHdoZW4gbm8gcmVzdW1hYmxlIHdvcmsgcmVtYWluc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlUm9hZG1hcChiYXNlLCB0cnVlKTtcbiAgICB3cml0ZUNvbXBsZXRlQXJ0aWZhY3RzKGJhc2UpO1xuICAgIHdyaXRlUGF1c2VkU2Vzc2lvbihiYXNlLCBcIk05OTlcIiwgdHJ1ZSk7XG5cbiAgICBjb25zdCBhc3Nlc3NtZW50ID0gYXdhaXQgYXNzZXNzSW50ZXJydXB0ZWRTZXNzaW9uKGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChhc3Nlc3NtZW50LmNsYXNzaWZpY2F0aW9uLCBcInN0YWxlXCIpO1xuICAgIGFzc2VydC5lcXVhbChhc3Nlc3NtZW50Lmhhc1Jlc3VtYWJsZURpc2tTdGF0ZSwgZmFsc2UpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGlyZWN0IC9nc2QgYXV0byBzb3VyY2Ugb25seSByZXN1bWVzIHBhdXNlZC1zZXNzaW9uIG1ldGFkYXRhIGZvciByZWNvdmVyYWJsZSBzdGF0ZSB3aXRoIHJlYWwgcmVjb3Zlcnkgc2lnbmFsc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHNvdXJjZSA9IGF3YWl0IGltcG9ydChgbm9kZTpmcy9wcm9taXNlc2ApLnRoZW4oKGZzKSA9PlxuICAgIGZzLnJlYWRGaWxlKG5ldyBVUkwoXCIuLi9hdXRvLnRzXCIsIGltcG9ydC5tZXRhLnVybCksIFwidXRmLThcIilcbiAgKTtcbiAgYXNzZXJ0Lm9rKHNvdXJjZS5pbmNsdWRlcygnY29uc3Qgc2hvdWxkUmVzdW1lUGF1c2VkU2Vzc2lvbiA9JykpO1xuICBhc3NlcnQub2soc291cmNlLmluY2x1ZGVzKCdmcmVzaFN0YXJ0QXNzZXNzbWVudC5jbGFzc2lmaWNhdGlvbiA9PT0gXCJyZWNvdmVyYWJsZVwiJykpO1xuICBhc3NlcnQub2soc291cmNlLmluY2x1ZGVzKCcmJiAoJykpO1xuICBhc3NlcnQub2soc291cmNlLmluY2x1ZGVzKCdmcmVzaFN0YXJ0QXNzZXNzbWVudC5oYXNSZXN1bWFibGVEaXNrU3RhdGUnKSk7XG4gIGFzc2VydC5vayhzb3VyY2UuaW5jbHVkZXMoJ3x8ICEhZnJlc2hTdGFydEFzc2Vzc21lbnQucmVjb3ZlcnlQcm9tcHQnKSk7XG4gIGFzc2VydC5vayhzb3VyY2UuaW5jbHVkZXMoJ3x8ICEhZnJlc2hTdGFydEFzc2Vzc21lbnQubG9jaycpKTtcbn0pO1xuXG50ZXN0KFwiYXV0byBtb2R1bGUgaW1wb3J0cyBzdWNjZXNzZnVsbHkgYWZ0ZXIgaW50ZXJydXB0ZWQtc2Vzc2lvbiBjaGFuZ2VzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgbW9kID0gYXdhaXQgaW1wb3J0KGAuLi9hdXRvLnRzP3RzPSR7RGF0ZS5ub3coKX0tJHtNYXRoLnJhbmRvbSgpfWApO1xuICBhc3NlcnQuZXF1YWwodHlwZW9mIG1vZC5zdGFydEF1dG8sIFwiZnVuY3Rpb25cIik7XG4gIGFzc2VydC5lcXVhbCh0eXBlb2YgbW9kLnBhdXNl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
