import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, unlinkSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  isDepthVerified,
  isDepthConfirmationAnswer,
  isQueuePhaseActive,
  shouldBlockContextWrite,
  setQueuePhaseActive
} from "../index.js";
import {
  markDepthVerified,
  isMilestoneDepthVerified,
  markApprovalGateVerified,
  shouldBlockContextArtifactSave,
  shouldBlockContextArtifactSaveInSnapshot,
  shouldBlockRootArtifactSaveInSnapshot,
  clearDiscussionFlowState,
  resetWriteGateState,
  loadWriteGateSnapshot
} from "../bootstrap/write-gate.js";
afterEach(() => {
  clearDiscussionFlowState(process.cwd());
});
test("write-gate: blocks CONTEXT.md write during discussion without depth verification (absolute path)", () => {
  const result = shouldBlockContextWrite(
    "write",
    "/Users/dev/project/.gsd/milestones/M001/M001-CONTEXT.md",
    "M001",
    false
  );
  assert.strictEqual(result.block, true, "should block the write");
  assert.ok(result.reason, "should provide a reason");
});
test("write-gate: blocks CONTEXT.md write during discussion without depth verification (relative path)", () => {
  const result = shouldBlockContextWrite(
    "write",
    ".gsd/milestones/M005/M005-CONTEXT.md",
    "M005",
    false
  );
  assert.strictEqual(result.block, true, "should block the write");
  assert.ok(result.reason, "should provide a reason");
});
test("write-gate: allows CONTEXT.md write after depth verification", () => {
  clearDiscussionFlowState(process.cwd());
  markDepthVerified("M001");
  const result = shouldBlockContextWrite(
    "write",
    "/Users/dev/project/.gsd/milestones/M001/M001-CONTEXT.md",
    "M001"
  );
  assert.strictEqual(result.block, false, "should not block after depth verification");
  assert.strictEqual(result.reason, void 0, "should have no reason");
});
test("write-gate: blocks CONTEXT.md write when milestoneId is ambiguous", () => {
  const result = shouldBlockContextWrite(
    "write",
    ".gsd/milestones/M001/M001-CONTEXT.md",
    null
  );
  assert.strictEqual(result.block, true, "should block when milestone context is ambiguous");
});
test("write-gate: allows non-CONTEXT.md writes during discussion", () => {
  const r1 = shouldBlockContextWrite(
    "write",
    ".gsd/milestones/M001/M001-DISCUSSION.md",
    "M001"
  );
  assert.strictEqual(r1.block, false, "DISCUSSION.md should pass");
  const r2 = shouldBlockContextWrite(
    "write",
    ".gsd/milestones/M001/slices/S01/S01-PLAN.md",
    "M001"
  );
  assert.strictEqual(r2.block, false, "slice plan should pass");
  const r3 = shouldBlockContextWrite(
    "write",
    "src/index.ts",
    "M001"
  );
  assert.strictEqual(r3.block, false, "regular code file should pass");
});
test("write-gate: regex does not match slice context files (S01-CONTEXT.md)", () => {
  const result = shouldBlockContextWrite(
    "write",
    ".gsd/milestones/M001/slices/S01/S01-CONTEXT.md",
    "M001"
  );
  assert.strictEqual(result.block, false, "S01-CONTEXT.md should not be blocked");
});
test("write-gate: blocked reason contains depth_verification keyword and anti-bypass language", () => {
  const result = shouldBlockContextWrite(
    "write",
    ".gsd/milestones/M999/M999-CONTEXT.md",
    "M999"
  );
  assert.strictEqual(result.block, true);
  assert.ok(result.reason.includes("depth_verification"), "reason should mention depth_verification question id");
  assert.ok(result.reason.includes("ask_user_questions"), "reason should mention ask_user_questions tool");
  assert.ok(result.reason.includes("MUST NOT"), "reason should include anti-bypass language");
  assert.ok(result.reason.includes("(Recommended)"), "reason should specify the required confirmation option");
});
test("write-gate: blocks CONTEXT.md write in queue mode without depth verification", () => {
  const result = shouldBlockContextWrite(
    "write",
    ".gsd/milestones/M001/M001-CONTEXT.md",
    null,
    // no milestoneId in queue mode
    true
    // queue phase active
  );
  assert.strictEqual(result.block, true, "should block in queue mode without depth verification");
  assert.ok(result.reason, "should provide a reason");
});
test("write-gate: allows CONTEXT.md write in queue mode after depth verification", () => {
  clearDiscussionFlowState(process.cwd());
  markDepthVerified("M001");
  const result = shouldBlockContextWrite(
    "write",
    ".gsd/milestones/M001/M001-CONTEXT.md",
    null,
    // no milestoneId in queue mode
    true
    // queue phase active
  );
  assert.strictEqual(result.block, false, "should not block in queue mode after depth verification");
});
test("write-gate: markDepthVerified unlocks only the matching milestone", () => {
  clearDiscussionFlowState(process.cwd());
  markDepthVerified("M001");
  const allowed = shouldBlockContextWrite(
    "write",
    ".gsd/milestones/M001/M001-CONTEXT.md",
    null
  );
  assert.strictEqual(allowed.block, false, "should allow the verified milestone");
  const blockedOther = shouldBlockContextWrite(
    "write",
    ".gsd/milestones/M002/M002-CONTEXT.md",
    null
  );
  assert.strictEqual(blockedOther.block, true, "other milestones should remain blocked");
  assert.strictEqual(isMilestoneDepthVerified("M001"), true);
  assert.strictEqual(isMilestoneDepthVerified("M002"), false);
});
test("write-gate: gsd_summary_save only blocks final milestone CONTEXT writes", () => {
  clearDiscussionFlowState(process.cwd());
  assert.strictEqual(
    shouldBlockContextArtifactSave("CONTEXT-DRAFT", "M001").block,
    false,
    "draft CONTEXT should be allowed"
  );
  assert.strictEqual(
    shouldBlockContextArtifactSave("CONTEXT", "M001", "S01").block,
    false,
    "slice CONTEXT should be allowed"
  );
  assert.strictEqual(
    shouldBlockContextArtifactSave("CONTEXT", "M001").block,
    true,
    "final milestone CONTEXT should block before verification"
  );
  markDepthVerified("M001");
  assert.strictEqual(
    shouldBlockContextArtifactSave("CONTEXT", "M001").block,
    false,
    "final milestone CONTEXT should pass after verification"
  );
});
test("write-gate: root PROJECT/REQUIREMENTS final saves block behind pending approval gate", () => {
  const snapshot = {
    verifiedDepthMilestones: [],
    verifiedApprovalGates: [],
    activeQueuePhase: false,
    pendingGateId: "depth_verification_requirements_confirm"
  };
  assert.strictEqual(
    shouldBlockRootArtifactSaveInSnapshot(snapshot, "REQUIREMENTS").block,
    true,
    "final REQUIREMENTS.md must wait for approval"
  );
  assert.strictEqual(
    shouldBlockRootArtifactSaveInSnapshot(snapshot, "PROJECT").block,
    true,
    "final PROJECT.md must wait for approval"
  );
  assert.strictEqual(
    shouldBlockRootArtifactSaveInSnapshot(snapshot, "REQUIREMENTS-DRAFT").block,
    false,
    "draft requirements can still be saved"
  );
  assert.strictEqual(
    shouldBlockRootArtifactSaveInSnapshot({ ...snapshot, pendingGateId: null }, "REQUIREMENTS").block,
    false,
    "no pending approval gate means final root artifacts can save"
  );
});
test("write-gate: deep root PROJECT/REQUIREMENTS final saves require verified approval", () => {
  const snapshot = {
    verifiedDepthMilestones: [],
    verifiedApprovalGates: [],
    activeQueuePhase: false,
    pendingGateId: null
  };
  assert.strictEqual(
    shouldBlockRootArtifactSaveInSnapshot(
      snapshot,
      "PROJECT",
      { requireVerifiedApproval: true }
    ).block,
    true,
    "deep PROJECT save is fail-closed without verified project approval"
  );
  assert.strictEqual(
    shouldBlockRootArtifactSaveInSnapshot(
      { ...snapshot, verifiedApprovalGates: ["depth_verification_project_confirm"] },
      "PROJECT",
      { requireVerifiedApproval: true }
    ).block,
    false,
    "verified project approval unlocks PROJECT"
  );
  assert.strictEqual(
    shouldBlockRootArtifactSaveInSnapshot(
      { ...snapshot, verifiedApprovalGates: ["depth_verification_project_confirm"] },
      "REQUIREMENTS",
      { requireVerifiedApproval: true }
    ).block,
    true,
    "project approval does not unlock REQUIREMENTS"
  );
  assert.strictEqual(
    shouldBlockRootArtifactSaveInSnapshot(
      { ...snapshot, verifiedApprovalGates: ["depth_verification_requirements_confirm"] },
      "REQUIREMENTS",
      { requireVerifiedApproval: true }
    ).block,
    false,
    "verified requirements approval unlocks REQUIREMENTS"
  );
});
test("write-gate: reopening a gate revokes its previous verified approval", () => {
  const base = join(tmpdir(), `gsd-write-gate-reopen-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  try {
    clearDiscussionFlowState(base);
    markApprovalGateVerified("depth_verification_project_confirm", base);
    assert.strictEqual(
      shouldBlockRootArtifactSaveInSnapshot(
        loadWriteGateSnapshot(base),
        "PROJECT",
        { requireVerifiedApproval: true }
      ).block,
      false,
      "precondition: verified approval unlocks the final project artifact"
    );
    setPendingGate("depth_verification_project_confirm", base);
    clearPendingGate(base);
    assert.strictEqual(
      shouldBlockRootArtifactSaveInSnapshot(
        loadWriteGateSnapshot(base),
        "PROJECT",
        { requireVerifiedApproval: true }
      ).block,
      true,
      "a re-asked gate must require a fresh approval"
    );
  } finally {
    clearDiscussionFlowState(base);
    rmSync(base, { recursive: true, force: true });
  }
});
import {
  isGateQuestionId,
  shouldBlockPendingGate,
  shouldBlockPendingGateBash,
  setPendingGate,
  clearPendingGate,
  getPendingGate
} from "../bootstrap/write-gate.js";
test("write-gate: isGateQuestionId recognizes all gate patterns", () => {
  assert.strictEqual(isGateQuestionId("depth_verification"), true);
  assert.strictEqual(isGateQuestionId("depth_verification_M002"), true);
  assert.strictEqual(isGateQuestionId("depth_verification_confirm"), true);
  assert.strictEqual(isGateQuestionId("project_intent"), false);
  assert.strictEqual(isGateQuestionId("feature_priority"), false);
  assert.strictEqual(isGateQuestionId("layer1_scope_gate"), false);
  assert.strictEqual(isGateQuestionId(""), false);
});
test("write-gate: pending gate lifecycle (set, get, clear)", () => {
  clearDiscussionFlowState(process.cwd());
  assert.strictEqual(getPendingGate(), null, "starts null");
  setPendingGate("depth_verification", process.cwd());
  assert.strictEqual(getPendingGate(), "depth_verification", "set correctly");
  clearPendingGate(process.cwd());
  assert.strictEqual(getPendingGate(), null, "cleared correctly");
  setPendingGate("depth_verification_M002", process.cwd());
  clearDiscussionFlowState(process.cwd());
  assert.strictEqual(getPendingGate(), null, "clearDiscussionFlowState clears pending gate");
});
test("write-gate: shouldBlockPendingGate blocks write/edit during pending gate", () => {
  clearDiscussionFlowState(process.cwd());
  setPendingGate("depth_verification", process.cwd());
  const writeResult = shouldBlockPendingGate("write", "M001", false);
  assert.strictEqual(writeResult.block, true, "write should be blocked");
  assert.ok(writeResult.reason.includes("depth_verification"), "reason mentions the gate");
  const editResult = shouldBlockPendingGate("edit", "M001", false);
  assert.strictEqual(editResult.block, true, "edit should be blocked");
  const gsdResult = shouldBlockPendingGate("gsd_plan_milestone", "M001", false);
  assert.strictEqual(gsdResult.block, true, "gsd tools should be blocked");
});
test("write-gate: shouldBlockPendingGate blocks read-only tools and allows ask_user_questions during pending gate", () => {
  clearDiscussionFlowState(process.cwd());
  setPendingGate("depth_verification", process.cwd());
  assert.strictEqual(shouldBlockPendingGate("ask_user_questions", "M001").block, false);
  assert.strictEqual(shouldBlockPendingGate("read", "M001").block, true);
  assert.strictEqual(shouldBlockPendingGate("grep", "M001").block, true);
  assert.strictEqual(shouldBlockPendingGate("glob", "M001").block, true);
  assert.strictEqual(shouldBlockPendingGate("ls", "M001").block, true);
});
test("write-gate: shouldBlockPendingGate blocks outside discussion when a gate is pending", () => {
  clearDiscussionFlowState(process.cwd());
  setPendingGate("depth_verification", process.cwd());
  const result = shouldBlockPendingGate("write", null, false);
  assert.strictEqual(result.block, true, "should block even when milestoneId is null");
});
test("write-gate: shouldBlockPendingGate blocks in queue mode when gate is pending", () => {
  clearDiscussionFlowState(process.cwd());
  setQueuePhaseActive(true, process.cwd());
  setPendingGate("depth_verification", process.cwd());
  const result = shouldBlockPendingGate("write", null, true);
  assert.strictEqual(result.block, true, "should block in queue mode");
});
test("write-gate: shouldBlockPendingGateBash blocks read-only commands during pending gate", () => {
  clearDiscussionFlowState(process.cwd());
  setPendingGate("depth_verification", process.cwd());
  assert.strictEqual(shouldBlockPendingGateBash("cat file.txt", "M001").block, true);
  assert.strictEqual(shouldBlockPendingGateBash("git log --oneline", "M001").block, true);
  assert.strictEqual(shouldBlockPendingGateBash("grep -r pattern .", "M001").block, true);
  assert.strictEqual(shouldBlockPendingGateBash("ls -la", "M001").block, true);
});
test("write-gate: shouldBlockPendingGateBash blocks mutating commands during pending gate", () => {
  clearDiscussionFlowState(process.cwd());
  setPendingGate("depth_verification", process.cwd());
  const result = shouldBlockPendingGateBash("npm run build", "M001");
  assert.strictEqual(result.block, true, "mutating bash should be blocked");
  assert.ok(result.reason.includes("depth_verification"));
});
test("write-gate: no pending gate means no blocking", () => {
  clearDiscussionFlowState(process.cwd());
  assert.strictEqual(shouldBlockPendingGate("write", "M001").block, false);
  assert.strictEqual(shouldBlockPendingGateBash("npm run build", "M001").block, false);
});
test("write-gate: resetWriteGateState clears pending gate", () => {
  setPendingGate("depth_verification", process.cwd());
  resetWriteGateState(process.cwd());
  assert.strictEqual(getPendingGate(), null);
});
test("write-gate: in-memory state is scoped by basePath", () => {
  const workspaceA = join(tmpdir(), `gsd-write-gate-isolation-a-${randomUUID()}`);
  const workspaceB = join(tmpdir(), `gsd-write-gate-isolation-b-${randomUUID()}`);
  try {
    clearDiscussionFlowState(workspaceA);
    clearDiscussionFlowState(workspaceB);
    setPendingGate("depth_verification_M777", workspaceA);
    assert.strictEqual(getPendingGate(workspaceA), "depth_verification_M777", "workspace A should see its pending gate");
    assert.strictEqual(getPendingGate(workspaceB), null, "workspace B should not see workspace A pending gate");
    clearPendingGate(workspaceA);
    setQueuePhaseActive(true, workspaceA);
    assert.strictEqual(isQueuePhaseActive(workspaceA), true, "workspace A should see queue mode active");
    assert.strictEqual(isQueuePhaseActive(workspaceB), false, "workspace B should not see workspace A queue mode");
    markDepthVerified("M777", workspaceA);
    assert.strictEqual(isMilestoneDepthVerified("M777", workspaceA), true, "workspace A should see its verified milestone");
    assert.strictEqual(isMilestoneDepthVerified("M777", workspaceB), false, "workspace B should not see workspace A milestone verification");
    assert.strictEqual(isDepthVerified(workspaceB), false, "workspace B should have no verified depth state");
  } finally {
    clearDiscussionFlowState(workspaceA);
    clearDiscussionFlowState(workspaceB);
    rmSync(workspaceA, { recursive: true, force: true });
    rmSync(workspaceB, { recursive: true, force: true });
  }
});
const STANDARD_OPTIONS = [
  { label: "Yes, you got it (Recommended)" },
  { label: "Not quite \u2014 let me clarify" }
];
test("write-gate: isDepthConfirmationAnswer accepts first option with options present", () => {
  assert.strictEqual(
    isDepthConfirmationAnswer("Yes, you got it (Recommended)", STANDARD_OPTIONS),
    true,
    "should accept exact match of first option label"
  );
});
test("write-gate: isDepthConfirmationAnswer rejects decline option", () => {
  assert.strictEqual(
    isDepthConfirmationAnswer("Not quite \u2014 let me clarify", STANDARD_OPTIONS),
    false,
    "should reject the clarification option"
  );
});
test("write-gate: isDepthConfirmationAnswer rejects None of the above", () => {
  assert.strictEqual(
    isDepthConfirmationAnswer("None of the above", STANDARD_OPTIONS),
    false,
    "should reject None of the above"
  );
});
test("write-gate: isDepthConfirmationAnswer rejects garbage and edge cases", () => {
  assert.strictEqual(isDepthConfirmationAnswer("discord", STANDARD_OPTIONS), false, "garbage string");
  assert.strictEqual(isDepthConfirmationAnswer("", STANDARD_OPTIONS), false, "empty string");
  assert.strictEqual(isDepthConfirmationAnswer(void 0, STANDARD_OPTIONS), false, "undefined");
  assert.strictEqual(isDepthConfirmationAnswer(null, STANDARD_OPTIONS), false, "null");
  assert.strictEqual(isDepthConfirmationAnswer(42, STANDARD_OPTIONS), false, "number");
});
test("write-gate: isDepthConfirmationAnswer handles array-wrapped selected value", () => {
  assert.strictEqual(
    isDepthConfirmationAnswer(["Yes, you got it (Recommended)"], STANDARD_OPTIONS),
    true,
    "should accept array-wrapped confirmation"
  );
  assert.strictEqual(
    isDepthConfirmationAnswer(["Not quite \u2014 let me clarify"], STANDARD_OPTIONS),
    false,
    "should reject array-wrapped decline"
  );
  assert.strictEqual(
    isDepthConfirmationAnswer([], STANDARD_OPTIONS),
    false,
    "should reject empty array"
  );
});
test("write-gate: isDepthConfirmationAnswer rejects free-form text containing Recommended", () => {
  assert.strictEqual(
    isDepthConfirmationAnswer("I think this is fine (Recommended)", STANDARD_OPTIONS),
    false,
    "free-form text with (Recommended) substring must not unlock gate"
  );
  assert.strictEqual(
    isDepthConfirmationAnswer("(Recommended)", STANDARD_OPTIONS),
    false,
    "bare (Recommended) string must not unlock gate"
  );
});
test("write-gate: isDepthConfirmationAnswer works with different label text", () => {
  const customOptions = [
    { label: "Looks good, proceed" },
    { label: "Needs more discussion" }
  ];
  assert.strictEqual(
    isDepthConfirmationAnswer("Looks good, proceed", customOptions),
    true,
    "should accept first option regardless of label text"
  );
  assert.strictEqual(
    isDepthConfirmationAnswer("Needs more discussion", customOptions),
    false,
    "should reject second option"
  );
  assert.strictEqual(
    isDepthConfirmationAnswer("Yes, you got it (Recommended)", customOptions),
    false,
    "old label text should not match new options"
  );
});
test("write-gate: isDepthConfirmationAnswer fails closed when options are missing (#4950)", () => {
  assert.strictEqual(
    isDepthConfirmationAnswer("Yes, you got it (Recommended)"),
    false,
    "no-options + Recommended substring must NOT unlock the gate"
  );
  assert.strictEqual(
    isDepthConfirmationAnswer("Not quite \u2014 let me clarify"),
    false,
    "no-options + non-Recommended must NOT unlock the gate"
  );
});
test("write-gate: loadWriteGateSnapshot returns empty default when persist file is deleted (#4343)", () => {
  const base = join(tmpdir(), `gsd-write-gate-4343-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  const stateFilePath = join(base, ".gsd", "runtime", "write-gate-state.json");
  const originalEnv = process.env.GSD_PERSIST_WRITE_GATE_STATE;
  try {
    process.env.GSD_PERSIST_WRITE_GATE_STATE = "1";
    writeFileSync(stateFilePath, JSON.stringify({
      verifiedDepthMilestones: ["M001"],
      activeQueuePhase: false,
      pendingGateId: "depth_verification_M001"
    }));
    assert.ok(existsSync(stateFilePath), "precondition: state file exists");
    const beforeDeletion = loadWriteGateSnapshot(base);
    assert.strictEqual(beforeDeletion.pendingGateId, "depth_verification_M001", "pending gate from file");
    assert.deepEqual(beforeDeletion.verifiedDepthMilestones, ["M001"], "verified milestones from file");
    unlinkSync(stateFilePath);
    assert.ok(!existsSync(stateFilePath), "state file deleted");
    const afterDeletion = loadWriteGateSnapshot(base);
    assert.strictEqual(afterDeletion.pendingGateId, null, "pendingGateId cleared after file deletion");
    assert.deepEqual(afterDeletion.verifiedDepthMilestones, [], "verifiedDepthMilestones cleared after file deletion");
    assert.strictEqual(afterDeletion.activeQueuePhase, false, "activeQueuePhase cleared after file deletion");
    const stillBlocked = shouldBlockContextArtifactSaveInSnapshot(afterDeletion, "CONTEXT", "M001", null);
    assert.strictEqual(stillBlocked.block, true, "still blocked without new depth verification");
    const verifiedSnapshot = {
      ...afterDeletion,
      verifiedDepthMilestones: ["M001"]
    };
    const unblocked = shouldBlockContextArtifactSaveInSnapshot(verifiedSnapshot, "CONTEXT", "M001", null);
    assert.strictEqual(unblocked.block, false, "unblocked after fresh depth verification");
  } finally {
    if (originalEnv === void 0) {
      delete process.env.GSD_PERSIST_WRITE_GATE_STATE;
    } else {
      process.env.GSD_PERSIST_WRITE_GATE_STATE = originalEnv;
    }
    clearDiscussionFlowState(base);
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  }
});
test("write-gate: resetWriteGateState persists through dangling .gsd symlink", () => {
  const base = join(tmpdir(), `gsd-write-gate-dangling-${randomUUID()}`);
  const externalState = join(tmpdir(), `gsd-write-gate-external-${randomUUID()}`);
  const stateFilePath = join(base, ".gsd", "runtime", "write-gate-state.json");
  const originalEnv = process.env.GSD_PERSIST_WRITE_GATE_STATE;
  try {
    process.env.GSD_PERSIST_WRITE_GATE_STATE = "1";
    mkdirSync(base, { recursive: true });
    symlinkSync(externalState, join(base, ".gsd"), "junction");
    assert.strictEqual(existsSync(join(base, ".gsd")), false, "precondition: .gsd symlink target is missing");
    resetWriteGateState(base);
    assert.ok(existsSync(externalState), "missing external state target was recreated");
    assert.ok(existsSync(stateFilePath), "write-gate snapshot persisted under .gsd/runtime");
    assert.deepEqual(loadWriteGateSnapshot(base), {
      verifiedDepthMilestones: [],
      verifiedApprovalGates: [],
      activeQueuePhase: false,
      pendingGateId: null
    });
  } finally {
    if (originalEnv === void 0) {
      delete process.env.GSD_PERSIST_WRITE_GATE_STATE;
    } else {
      process.env.GSD_PERSIST_WRITE_GATE_STATE = originalEnv;
    }
    clearDiscussionFlowState(base);
    try {
      rmSync(base, { recursive: true, force: true });
      rmSync(externalState, { recursive: true, force: true });
    } catch {
    }
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93cml0ZS1nYXRlLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRDIgLSBXcml0ZSBnYXRlIHJlZ3Jlc3Npb24gdGVzdHMuXG4vKipcbiAqIFVuaXQgdGVzdHMgZm9yIHRoZSBDT05URVhULm1kIHdyaXRlLWdhdGUgKEQwMzEgZ3VhcmQgY2hhaW4pLlxuICpcbiAqIEV4ZXJjaXNlcyBzaG91bGRCbG9ja0NvbnRleHRXcml0ZSgpIFx1MjAxNCBhIHB1cmUgZnVuY3Rpb24gdGhhdCBpbXBsZW1lbnRzOlxuICogICAoYSkgdG9vbE5hbWUgIT09IFwid3JpdGVcIiBcdTIxOTIgcGFzc1xuICogICAoYikgbWlsZXN0b25lIGNvbnRleHQgbXVzdCByZXNvbHZlIHRvIGEgdmVyaWZpZWQgbWlsZXN0b25lXG4gKiAgIChjKSBwYXRoIGRvZXNuJ3QgbWF0Y2ggL01cXGQrLUNPTlRFWFRcXC5tZCQvIFx1MjE5MiBwYXNzXG4gKiAgIChkKSBub24tY29udGV4dCBmaWxlcyBcdTIxOTIgcGFzc1xuICogICAoZSkgZWxzZSBcdTIxOTIgYmxvY2sgd2l0aCBhY3Rpb25hYmxlIHJlYXNvblxuICovXG5cbmltcG9ydCB0ZXN0LCB7IGFmdGVyRWFjaCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBta2RpclN5bmMsIHdyaXRlRmlsZVN5bmMsIHVubGlua1N5bmMsIGV4aXN0c1N5bmMsIHJtU3luYywgc3ltbGlua1N5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xuaW1wb3J0IHtcbiAgaXNEZXB0aFZlcmlmaWVkLFxuICBpc0RlcHRoQ29uZmlybWF0aW9uQW5zd2VyLFxuICBpc1F1ZXVlUGhhc2VBY3RpdmUsXG4gIHNob3VsZEJsb2NrQ29udGV4dFdyaXRlLFxuICBzZXRRdWV1ZVBoYXNlQWN0aXZlLFxufSBmcm9tICcuLi9pbmRleC50cyc7XG5pbXBvcnQge1xuICBtYXJrRGVwdGhWZXJpZmllZCxcbiAgaXNNaWxlc3RvbmVEZXB0aFZlcmlmaWVkLFxuICBtYXJrQXBwcm92YWxHYXRlVmVyaWZpZWQsXG4gIHNob3VsZEJsb2NrQ29udGV4dEFydGlmYWN0U2F2ZSxcbiAgc2hvdWxkQmxvY2tDb250ZXh0QXJ0aWZhY3RTYXZlSW5TbmFwc2hvdCxcbiAgc2hvdWxkQmxvY2tSb290QXJ0aWZhY3RTYXZlSW5TbmFwc2hvdCxcbiAgY2xlYXJEaXNjdXNzaW9uRmxvd1N0YXRlLFxuICByZXNldFdyaXRlR2F0ZVN0YXRlLFxuICBsb2FkV3JpdGVHYXRlU25hcHNob3QsXG59IGZyb20gJy4uL2Jvb3RzdHJhcC93cml0ZS1nYXRlLnRzJztcblxuYWZ0ZXJFYWNoKCgpID0+IHtcbiAgY2xlYXJEaXNjdXNzaW9uRmxvd1N0YXRlKHByb2Nlc3MuY3dkKCkpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTY2VuYXJpbyAxOiBCbG9ja3MgQ09OVEVYVC5tZCB3cml0ZSBkdXJpbmcgZGlzY3Vzc2lvbiB3aXRob3V0IGRlcHRoIHZlcmlmaWNhdGlvbiAoYWJzb2x1dGUgcGF0aCkgXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ3dyaXRlLWdhdGU6IGJsb2NrcyBDT05URVhULm1kIHdyaXRlIGR1cmluZyBkaXNjdXNzaW9uIHdpdGhvdXQgZGVwdGggdmVyaWZpY2F0aW9uIChhYnNvbHV0ZSBwYXRoKScsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gc2hvdWxkQmxvY2tDb250ZXh0V3JpdGUoXG4gICAgJ3dyaXRlJyxcbiAgICAnL1VzZXJzL2Rldi9wcm9qZWN0Ly5nc2QvbWlsZXN0b25lcy9NMDAxL00wMDEtQ09OVEVYVC5tZCcsXG4gICAgJ00wMDEnLFxuICAgIGZhbHNlLFxuICApO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmJsb2NrLCB0cnVlLCAnc2hvdWxkIGJsb2NrIHRoZSB3cml0ZScpO1xuICBhc3NlcnQub2socmVzdWx0LnJlYXNvbiwgJ3Nob3VsZCBwcm92aWRlIGEgcmVhc29uJyk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNjZW5hcmlvIDI6IEJsb2NrcyBDT05URVhULm1kIHdyaXRlIGR1cmluZyBkaXNjdXNzaW9uIHdpdGhvdXQgZGVwdGggdmVyaWZpY2F0aW9uIChyZWxhdGl2ZSBwYXRoKSBcdTI1MDBcdTI1MDBcblxudGVzdCgnd3JpdGUtZ2F0ZTogYmxvY2tzIENPTlRFWFQubWQgd3JpdGUgZHVyaW5nIGRpc2N1c3Npb24gd2l0aG91dCBkZXB0aCB2ZXJpZmljYXRpb24gKHJlbGF0aXZlIHBhdGgpJywgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBzaG91bGRCbG9ja0NvbnRleHRXcml0ZShcbiAgICAnd3JpdGUnLFxuICAgICcuZ3NkL21pbGVzdG9uZXMvTTAwNS9NMDA1LUNPTlRFWFQubWQnLFxuICAgICdNMDA1JyxcbiAgICBmYWxzZSxcbiAgKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5ibG9jaywgdHJ1ZSwgJ3Nob3VsZCBibG9jayB0aGUgd3JpdGUnKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5yZWFzb24sICdzaG91bGQgcHJvdmlkZSBhIHJlYXNvbicpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTY2VuYXJpbyAzOiBBbGxvd3MgQ09OVEVYVC5tZCB3cml0ZSBhZnRlciBkZXB0aCB2ZXJpZmljYXRpb24gXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ3dyaXRlLWdhdGU6IGFsbG93cyBDT05URVhULm1kIHdyaXRlIGFmdGVyIGRlcHRoIHZlcmlmaWNhdGlvbicsICgpID0+IHtcbiAgY2xlYXJEaXNjdXNzaW9uRmxvd1N0YXRlKHByb2Nlc3MuY3dkKCkpO1xuICBtYXJrRGVwdGhWZXJpZmllZCgnTTAwMScpO1xuICBjb25zdCByZXN1bHQgPSBzaG91bGRCbG9ja0NvbnRleHRXcml0ZShcbiAgICAnd3JpdGUnLFxuICAgICcvVXNlcnMvZGV2L3Byb2plY3QvLmdzZC9taWxlc3RvbmVzL00wMDEvTTAwMS1DT05URVhULm1kJyxcbiAgICAnTTAwMScsXG4gICk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuYmxvY2ssIGZhbHNlLCAnc2hvdWxkIG5vdCBibG9jayBhZnRlciBkZXB0aCB2ZXJpZmljYXRpb24nKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5yZWFzb24sIHVuZGVmaW5lZCwgJ3Nob3VsZCBoYXZlIG5vIHJlYXNvbicpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTY2VuYXJpbyA0OiBBbWJpZ3VvdXMgc2Vzc2lvbiBjb250ZXh0IG5vIGxvbmdlciBieXBhc3NlcyB0aGUgZ2F0ZSBcdTI1MDBcdTI1MDBcblxudGVzdCgnd3JpdGUtZ2F0ZTogYmxvY2tzIENPTlRFWFQubWQgd3JpdGUgd2hlbiBtaWxlc3RvbmVJZCBpcyBhbWJpZ3VvdXMnLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHNob3VsZEJsb2NrQ29udGV4dFdyaXRlKFxuICAgICd3cml0ZScsXG4gICAgJy5nc2QvbWlsZXN0b25lcy9NMDAxL00wMDEtQ09OVEVYVC5tZCcsXG4gICAgbnVsbCxcbiAgKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5ibG9jaywgdHJ1ZSwgJ3Nob3VsZCBibG9jayB3aGVuIG1pbGVzdG9uZSBjb250ZXh0IGlzIGFtYmlndW91cycpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTY2VuYXJpbyA1OiBBbGxvd3Mgbm9uLUNPTlRFWFQubWQgd3JpdGVzIGR1cmluZyBkaXNjdXNzaW9uIFx1MjUwMFx1MjUwMFxuXG50ZXN0KCd3cml0ZS1nYXRlOiBhbGxvd3Mgbm9uLUNPTlRFWFQubWQgd3JpdGVzIGR1cmluZyBkaXNjdXNzaW9uJywgKCkgPT4ge1xuICAvLyBESVNDVVNTSU9OLm1kXG4gIGNvbnN0IHIxID0gc2hvdWxkQmxvY2tDb250ZXh0V3JpdGUoXG4gICAgJ3dyaXRlJyxcbiAgICAnLmdzZC9taWxlc3RvbmVzL00wMDEvTTAwMS1ESVNDVVNTSU9OLm1kJyxcbiAgICAnTTAwMScsXG4gICk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyMS5ibG9jaywgZmFsc2UsICdESVNDVVNTSU9OLm1kIHNob3VsZCBwYXNzJyk7XG5cbiAgLy8gU2xpY2UgZmlsZVxuICBjb25zdCByMiA9IHNob3VsZEJsb2NrQ29udGV4dFdyaXRlKFxuICAgICd3cml0ZScsXG4gICAgJy5nc2QvbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVBMQU4ubWQnLFxuICAgICdNMDAxJyxcbiAgKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHIyLmJsb2NrLCBmYWxzZSwgJ3NsaWNlIHBsYW4gc2hvdWxkIHBhc3MnKTtcblxuICAvLyBSZWd1bGFyIGNvZGUgZmlsZVxuICBjb25zdCByMyA9IHNob3VsZEJsb2NrQ29udGV4dFdyaXRlKFxuICAgICd3cml0ZScsXG4gICAgJ3NyYy9pbmRleC50cycsXG4gICAgJ00wMDEnLFxuICApO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocjMuYmxvY2ssIGZhbHNlLCAncmVndWxhciBjb2RlIGZpbGUgc2hvdWxkIHBhc3MnKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2NlbmFyaW8gNjogUmVnZXggc3BlY2lmaWNpdHkgXHUyMDE0IGRvZXNuJ3QgbWF0Y2ggUzAxLUNPTlRFWFQubWQgXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ3dyaXRlLWdhdGU6IHJlZ2V4IGRvZXMgbm90IG1hdGNoIHNsaWNlIGNvbnRleHQgZmlsZXMgKFMwMS1DT05URVhULm1kKScsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gc2hvdWxkQmxvY2tDb250ZXh0V3JpdGUoXG4gICAgJ3dyaXRlJyxcbiAgICAnLmdzZC9taWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS9TMDEtQ09OVEVYVC5tZCcsXG4gICAgJ00wMDEnLFxuICApO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmJsb2NrLCBmYWxzZSwgJ1MwMS1DT05URVhULm1kIHNob3VsZCBub3QgYmUgYmxvY2tlZCcpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTY2VuYXJpbyA3OiBFcnJvciBtZXNzYWdlIGNvbnRhaW5zIGFjdGlvbmFibGUgaW5zdHJ1Y3Rpb24gYW5kIGFudGktYnlwYXNzIGxhbmd1YWdlIFx1MjUwMFx1MjUwMFxuXG50ZXN0KCd3cml0ZS1nYXRlOiBibG9ja2VkIHJlYXNvbiBjb250YWlucyBkZXB0aF92ZXJpZmljYXRpb24ga2V5d29yZCBhbmQgYW50aS1ieXBhc3MgbGFuZ3VhZ2UnLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHNob3VsZEJsb2NrQ29udGV4dFdyaXRlKFxuICAgICd3cml0ZScsXG4gICAgJy5nc2QvbWlsZXN0b25lcy9NOTk5L005OTktQ09OVEVYVC5tZCcsXG4gICAgJ005OTknLFxuICApO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmJsb2NrLCB0cnVlKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5yZWFzb24hLmluY2x1ZGVzKCdkZXB0aF92ZXJpZmljYXRpb24nKSwgJ3JlYXNvbiBzaG91bGQgbWVudGlvbiBkZXB0aF92ZXJpZmljYXRpb24gcXVlc3Rpb24gaWQnKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5yZWFzb24hLmluY2x1ZGVzKCdhc2tfdXNlcl9xdWVzdGlvbnMnKSwgJ3JlYXNvbiBzaG91bGQgbWVudGlvbiBhc2tfdXNlcl9xdWVzdGlvbnMgdG9vbCcpO1xuICBhc3NlcnQub2socmVzdWx0LnJlYXNvbiEuaW5jbHVkZXMoJ01VU1QgTk9UJyksICdyZWFzb24gc2hvdWxkIGluY2x1ZGUgYW50aS1ieXBhc3MgbGFuZ3VhZ2UnKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5yZWFzb24hLmluY2x1ZGVzKCcoUmVjb21tZW5kZWQpJyksICdyZWFzb24gc2hvdWxkIHNwZWNpZnkgdGhlIHJlcXVpcmVkIGNvbmZpcm1hdGlvbiBvcHRpb24nKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2NlbmFyaW8gODogUXVldWUgbW9kZSBibG9ja3MgQ09OVEVYVC5tZCB3cml0ZSB3aXRob3V0IGRlcHRoIHZlcmlmaWNhdGlvbiBcdTI1MDBcdTI1MDBcblxudGVzdCgnd3JpdGUtZ2F0ZTogYmxvY2tzIENPTlRFWFQubWQgd3JpdGUgaW4gcXVldWUgbW9kZSB3aXRob3V0IGRlcHRoIHZlcmlmaWNhdGlvbicsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gc2hvdWxkQmxvY2tDb250ZXh0V3JpdGUoXG4gICAgJ3dyaXRlJyxcbiAgICAnLmdzZC9taWxlc3RvbmVzL00wMDEvTTAwMS1DT05URVhULm1kJyxcbiAgICBudWxsLCAgIC8vIG5vIG1pbGVzdG9uZUlkIGluIHF1ZXVlIG1vZGVcbiAgICB0cnVlLCAgIC8vIHF1ZXVlIHBoYXNlIGFjdGl2ZVxuICApO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmJsb2NrLCB0cnVlLCAnc2hvdWxkIGJsb2NrIGluIHF1ZXVlIG1vZGUgd2l0aG91dCBkZXB0aCB2ZXJpZmljYXRpb24nKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5yZWFzb24sICdzaG91bGQgcHJvdmlkZSBhIHJlYXNvbicpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTY2VuYXJpbyA5OiBRdWV1ZSBtb2RlIGFsbG93cyBDT05URVhULm1kIHdyaXRlIGFmdGVyIGRlcHRoIHZlcmlmaWNhdGlvbiBcdTI1MDBcdTI1MDBcblxudGVzdCgnd3JpdGUtZ2F0ZTogYWxsb3dzIENPTlRFWFQubWQgd3JpdGUgaW4gcXVldWUgbW9kZSBhZnRlciBkZXB0aCB2ZXJpZmljYXRpb24nLCAoKSA9PiB7XG4gIGNsZWFyRGlzY3Vzc2lvbkZsb3dTdGF0ZShwcm9jZXNzLmN3ZCgpKTtcbiAgbWFya0RlcHRoVmVyaWZpZWQoJ00wMDEnKTtcbiAgY29uc3QgcmVzdWx0ID0gc2hvdWxkQmxvY2tDb250ZXh0V3JpdGUoXG4gICAgJ3dyaXRlJyxcbiAgICAnLmdzZC9taWxlc3RvbmVzL00wMDEvTTAwMS1DT05URVhULm1kJyxcbiAgICBudWxsLCAgIC8vIG5vIG1pbGVzdG9uZUlkIGluIHF1ZXVlIG1vZGVcbiAgICB0cnVlLCAgIC8vIHF1ZXVlIHBoYXNlIGFjdGl2ZVxuICApO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmJsb2NrLCBmYWxzZSwgJ3Nob3VsZCBub3QgYmxvY2sgaW4gcXVldWUgbW9kZSBhZnRlciBkZXB0aCB2ZXJpZmljYXRpb24nKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2NlbmFyaW8gMTA6IGRlcHRoIHZlcmlmaWNhdGlvbiBpcyBzY29wZWQgcGVyIG1pbGVzdG9uZSwgbm90IGdsb2JhbCBcdTI1MDBcdTI1MDBcblxudGVzdCgnd3JpdGUtZ2F0ZTogbWFya0RlcHRoVmVyaWZpZWQgdW5sb2NrcyBvbmx5IHRoZSBtYXRjaGluZyBtaWxlc3RvbmUnLCAoKSA9PiB7XG4gIGNsZWFyRGlzY3Vzc2lvbkZsb3dTdGF0ZShwcm9jZXNzLmN3ZCgpKTtcbiAgbWFya0RlcHRoVmVyaWZpZWQoJ00wMDEnKTtcblxuICBjb25zdCBhbGxvd2VkID0gc2hvdWxkQmxvY2tDb250ZXh0V3JpdGUoXG4gICAgJ3dyaXRlJyxcbiAgICAnLmdzZC9taWxlc3RvbmVzL00wMDEvTTAwMS1DT05URVhULm1kJyxcbiAgICBudWxsLFxuICApO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoYWxsb3dlZC5ibG9jaywgZmFsc2UsICdzaG91bGQgYWxsb3cgdGhlIHZlcmlmaWVkIG1pbGVzdG9uZScpO1xuXG4gIGNvbnN0IGJsb2NrZWRPdGhlciA9IHNob3VsZEJsb2NrQ29udGV4dFdyaXRlKFxuICAgICd3cml0ZScsXG4gICAgJy5nc2QvbWlsZXN0b25lcy9NMDAyL00wMDItQ09OVEVYVC5tZCcsXG4gICAgbnVsbCxcbiAgKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGJsb2NrZWRPdGhlci5ibG9jaywgdHJ1ZSwgJ290aGVyIG1pbGVzdG9uZXMgc2hvdWxkIHJlbWFpbiBibG9ja2VkJyk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChpc01pbGVzdG9uZURlcHRoVmVyaWZpZWQoJ00wMDEnKSwgdHJ1ZSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChpc01pbGVzdG9uZURlcHRoVmVyaWZpZWQoJ00wMDInKSwgZmFsc2UpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTY2VuYXJpbyAxMTogZ3NkX3N1bW1hcnlfc2F2ZSBDT05URVhUIGNvbnRyYWN0IGlzIG1pbGVzdG9uZS1zY29wZWQgXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ3dyaXRlLWdhdGU6IGdzZF9zdW1tYXJ5X3NhdmUgb25seSBibG9ja3MgZmluYWwgbWlsZXN0b25lIENPTlRFWFQgd3JpdGVzJywgKCkgPT4ge1xuICBjbGVhckRpc2N1c3Npb25GbG93U3RhdGUocHJvY2Vzcy5jd2QoKSk7XG5cbiAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgIHNob3VsZEJsb2NrQ29udGV4dEFydGlmYWN0U2F2ZSgnQ09OVEVYVC1EUkFGVCcsICdNMDAxJykuYmxvY2ssXG4gICAgZmFsc2UsXG4gICAgJ2RyYWZ0IENPTlRFWFQgc2hvdWxkIGJlIGFsbG93ZWQnLFxuICApO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoXG4gICAgc2hvdWxkQmxvY2tDb250ZXh0QXJ0aWZhY3RTYXZlKCdDT05URVhUJywgJ00wMDEnLCAnUzAxJykuYmxvY2ssXG4gICAgZmFsc2UsXG4gICAgJ3NsaWNlIENPTlRFWFQgc2hvdWxkIGJlIGFsbG93ZWQnLFxuICApO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoXG4gICAgc2hvdWxkQmxvY2tDb250ZXh0QXJ0aWZhY3RTYXZlKCdDT05URVhUJywgJ00wMDEnKS5ibG9jayxcbiAgICB0cnVlLFxuICAgICdmaW5hbCBtaWxlc3RvbmUgQ09OVEVYVCBzaG91bGQgYmxvY2sgYmVmb3JlIHZlcmlmaWNhdGlvbicsXG4gICk7XG5cbiAgbWFya0RlcHRoVmVyaWZpZWQoJ00wMDEnKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgIHNob3VsZEJsb2NrQ29udGV4dEFydGlmYWN0U2F2ZSgnQ09OVEVYVCcsICdNMDAxJykuYmxvY2ssXG4gICAgZmFsc2UsXG4gICAgJ2ZpbmFsIG1pbGVzdG9uZSBDT05URVhUIHNob3VsZCBwYXNzIGFmdGVyIHZlcmlmaWNhdGlvbicsXG4gICk7XG59KTtcblxudGVzdCgnd3JpdGUtZ2F0ZTogcm9vdCBQUk9KRUNUL1JFUVVJUkVNRU5UUyBmaW5hbCBzYXZlcyBibG9jayBiZWhpbmQgcGVuZGluZyBhcHByb3ZhbCBnYXRlJywgKCkgPT4ge1xuICBjb25zdCBzbmFwc2hvdCA9IHtcbiAgICB2ZXJpZmllZERlcHRoTWlsZXN0b25lczogW10sXG4gICAgdmVyaWZpZWRBcHByb3ZhbEdhdGVzOiBbXSxcbiAgICBhY3RpdmVRdWV1ZVBoYXNlOiBmYWxzZSxcbiAgICBwZW5kaW5nR2F0ZUlkOiAnZGVwdGhfdmVyaWZpY2F0aW9uX3JlcXVpcmVtZW50c19jb25maXJtJyxcbiAgfTtcblxuICBhc3NlcnQuc3RyaWN0RXF1YWwoXG4gICAgc2hvdWxkQmxvY2tSb290QXJ0aWZhY3RTYXZlSW5TbmFwc2hvdChzbmFwc2hvdCwgJ1JFUVVJUkVNRU5UUycpLmJsb2NrLFxuICAgIHRydWUsXG4gICAgJ2ZpbmFsIFJFUVVJUkVNRU5UUy5tZCBtdXN0IHdhaXQgZm9yIGFwcHJvdmFsJyxcbiAgKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgIHNob3VsZEJsb2NrUm9vdEFydGlmYWN0U2F2ZUluU25hcHNob3Qoc25hcHNob3QsICdQUk9KRUNUJykuYmxvY2ssXG4gICAgdHJ1ZSxcbiAgICAnZmluYWwgUFJPSkVDVC5tZCBtdXN0IHdhaXQgZm9yIGFwcHJvdmFsJyxcbiAgKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgIHNob3VsZEJsb2NrUm9vdEFydGlmYWN0U2F2ZUluU25hcHNob3Qoc25hcHNob3QsICdSRVFVSVJFTUVOVFMtRFJBRlQnKS5ibG9jayxcbiAgICBmYWxzZSxcbiAgICAnZHJhZnQgcmVxdWlyZW1lbnRzIGNhbiBzdGlsbCBiZSBzYXZlZCcsXG4gICk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChcbiAgICBzaG91bGRCbG9ja1Jvb3RBcnRpZmFjdFNhdmVJblNuYXBzaG90KHsgLi4uc25hcHNob3QsIHBlbmRpbmdHYXRlSWQ6IG51bGwgfSwgJ1JFUVVJUkVNRU5UUycpLmJsb2NrLFxuICAgIGZhbHNlLFxuICAgICdubyBwZW5kaW5nIGFwcHJvdmFsIGdhdGUgbWVhbnMgZmluYWwgcm9vdCBhcnRpZmFjdHMgY2FuIHNhdmUnLFxuICApO1xufSk7XG5cbnRlc3QoJ3dyaXRlLWdhdGU6IGRlZXAgcm9vdCBQUk9KRUNUL1JFUVVJUkVNRU5UUyBmaW5hbCBzYXZlcyByZXF1aXJlIHZlcmlmaWVkIGFwcHJvdmFsJywgKCkgPT4ge1xuICBjb25zdCBzbmFwc2hvdCA9IHtcbiAgICB2ZXJpZmllZERlcHRoTWlsZXN0b25lczogW10sXG4gICAgdmVyaWZpZWRBcHByb3ZhbEdhdGVzOiBbXSxcbiAgICBhY3RpdmVRdWV1ZVBoYXNlOiBmYWxzZSxcbiAgICBwZW5kaW5nR2F0ZUlkOiBudWxsLFxuICB9O1xuXG4gIGFzc2VydC5zdHJpY3RFcXVhbChcbiAgICBzaG91bGRCbG9ja1Jvb3RBcnRpZmFjdFNhdmVJblNuYXBzaG90KFxuICAgICAgc25hcHNob3QsXG4gICAgICAnUFJPSkVDVCcsXG4gICAgICB7IHJlcXVpcmVWZXJpZmllZEFwcHJvdmFsOiB0cnVlIH0sXG4gICAgKS5ibG9jayxcbiAgICB0cnVlLFxuICAgICdkZWVwIFBST0pFQ1Qgc2F2ZSBpcyBmYWlsLWNsb3NlZCB3aXRob3V0IHZlcmlmaWVkIHByb2plY3QgYXBwcm92YWwnLFxuICApO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoXG4gICAgc2hvdWxkQmxvY2tSb290QXJ0aWZhY3RTYXZlSW5TbmFwc2hvdChcbiAgICAgIHsgLi4uc25hcHNob3QsIHZlcmlmaWVkQXBwcm92YWxHYXRlczogWydkZXB0aF92ZXJpZmljYXRpb25fcHJvamVjdF9jb25maXJtJ10gfSxcbiAgICAgICdQUk9KRUNUJyxcbiAgICAgIHsgcmVxdWlyZVZlcmlmaWVkQXBwcm92YWw6IHRydWUgfSxcbiAgICApLmJsb2NrLFxuICAgIGZhbHNlLFxuICAgICd2ZXJpZmllZCBwcm9qZWN0IGFwcHJvdmFsIHVubG9ja3MgUFJPSkVDVCcsXG4gICk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChcbiAgICBzaG91bGRCbG9ja1Jvb3RBcnRpZmFjdFNhdmVJblNuYXBzaG90KFxuICAgICAgeyAuLi5zbmFwc2hvdCwgdmVyaWZpZWRBcHByb3ZhbEdhdGVzOiBbJ2RlcHRoX3ZlcmlmaWNhdGlvbl9wcm9qZWN0X2NvbmZpcm0nXSB9LFxuICAgICAgJ1JFUVVJUkVNRU5UUycsXG4gICAgICB7IHJlcXVpcmVWZXJpZmllZEFwcHJvdmFsOiB0cnVlIH0sXG4gICAgKS5ibG9jayxcbiAgICB0cnVlLFxuICAgICdwcm9qZWN0IGFwcHJvdmFsIGRvZXMgbm90IHVubG9jayBSRVFVSVJFTUVOVFMnLFxuICApO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoXG4gICAgc2hvdWxkQmxvY2tSb290QXJ0aWZhY3RTYXZlSW5TbmFwc2hvdChcbiAgICAgIHsgLi4uc25hcHNob3QsIHZlcmlmaWVkQXBwcm92YWxHYXRlczogWydkZXB0aF92ZXJpZmljYXRpb25fcmVxdWlyZW1lbnRzX2NvbmZpcm0nXSB9LFxuICAgICAgJ1JFUVVJUkVNRU5UUycsXG4gICAgICB7IHJlcXVpcmVWZXJpZmllZEFwcHJvdmFsOiB0cnVlIH0sXG4gICAgKS5ibG9jayxcbiAgICBmYWxzZSxcbiAgICAndmVyaWZpZWQgcmVxdWlyZW1lbnRzIGFwcHJvdmFsIHVubG9ja3MgUkVRVUlSRU1FTlRTJyxcbiAgKTtcbn0pO1xuXG50ZXN0KCd3cml0ZS1nYXRlOiByZW9wZW5pbmcgYSBnYXRlIHJldm9rZXMgaXRzIHByZXZpb3VzIHZlcmlmaWVkIGFwcHJvdmFsJywgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gam9pbih0bXBkaXIoKSwgYGdzZC13cml0ZS1nYXRlLXJlb3Blbi0ke3JhbmRvbVVVSUQoKX1gKTtcbiAgbWtkaXJTeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIHRyeSB7XG4gICAgY2xlYXJEaXNjdXNzaW9uRmxvd1N0YXRlKGJhc2UpO1xuXG4gICAgbWFya0FwcHJvdmFsR2F0ZVZlcmlmaWVkKCdkZXB0aF92ZXJpZmljYXRpb25fcHJvamVjdF9jb25maXJtJywgYmFzZSk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgICAgc2hvdWxkQmxvY2tSb290QXJ0aWZhY3RTYXZlSW5TbmFwc2hvdChcbiAgICAgICAgbG9hZFdyaXRlR2F0ZVNuYXBzaG90KGJhc2UpLFxuICAgICAgICAnUFJPSkVDVCcsXG4gICAgICAgIHsgcmVxdWlyZVZlcmlmaWVkQXBwcm92YWw6IHRydWUgfSxcbiAgICAgICkuYmxvY2ssXG4gICAgICBmYWxzZSxcbiAgICAgICdwcmVjb25kaXRpb246IHZlcmlmaWVkIGFwcHJvdmFsIHVubG9ja3MgdGhlIGZpbmFsIHByb2plY3QgYXJ0aWZhY3QnLFxuICAgICk7XG5cbiAgICBzZXRQZW5kaW5nR2F0ZSgnZGVwdGhfdmVyaWZpY2F0aW9uX3Byb2plY3RfY29uZmlybScsIGJhc2UpO1xuICAgIGNsZWFyUGVuZGluZ0dhdGUoYmFzZSk7XG5cbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoXG4gICAgICBzaG91bGRCbG9ja1Jvb3RBcnRpZmFjdFNhdmVJblNuYXBzaG90KFxuICAgICAgICBsb2FkV3JpdGVHYXRlU25hcHNob3QoYmFzZSksXG4gICAgICAgICdQUk9KRUNUJyxcbiAgICAgICAgeyByZXF1aXJlVmVyaWZpZWRBcHByb3ZhbDogdHJ1ZSB9LFxuICAgICAgKS5ibG9jayxcbiAgICAgIHRydWUsXG4gICAgICAnYSByZS1hc2tlZCBnYXRlIG11c3QgcmVxdWlyZSBhIGZyZXNoIGFwcHJvdmFsJyxcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFyRGlzY3Vzc2lvbkZsb3dTdGF0ZShiYXNlKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBEaXNjdXNzaW9uIGdhdGUgZW5mb3JjZW1lbnQgdGVzdHMgKHBlbmRpbmcgZ2F0ZSBtZWNoYW5pc20pXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuaW1wb3J0IHtcbiAgaXNHYXRlUXVlc3Rpb25JZCxcbiAgc2hvdWxkQmxvY2tQZW5kaW5nR2F0ZSxcbiAgc2hvdWxkQmxvY2tQZW5kaW5nR2F0ZUJhc2gsXG4gIHNldFBlbmRpbmdHYXRlLFxuICBjbGVhclBlbmRpbmdHYXRlLFxuICBnZXRQZW5kaW5nR2F0ZSxcbn0gZnJvbSAnLi4vYm9vdHN0cmFwL3dyaXRlLWdhdGUudHMnO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2NlbmFyaW8gMTk6IGlzR2F0ZVF1ZXN0aW9uSWQgcmVjb2duaXplcyBhbGwgZ2F0ZSBwYXR0ZXJucyBcdTI1MDBcdTI1MDBcblxudGVzdCgnd3JpdGUtZ2F0ZTogaXNHYXRlUXVlc3Rpb25JZCByZWNvZ25pemVzIGFsbCBnYXRlIHBhdHRlcm5zJywgKCkgPT4ge1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoaXNHYXRlUXVlc3Rpb25JZCgnZGVwdGhfdmVyaWZpY2F0aW9uJyksIHRydWUpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoaXNHYXRlUXVlc3Rpb25JZCgnZGVwdGhfdmVyaWZpY2F0aW9uX00wMDInKSwgdHJ1ZSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChpc0dhdGVRdWVzdGlvbklkKCdkZXB0aF92ZXJpZmljYXRpb25fY29uZmlybScpLCB0cnVlKTtcbiAgLy8gTm9uLWdhdGUgcXVlc3Rpb24gSURzXG4gIGFzc2VydC5zdHJpY3RFcXVhbChpc0dhdGVRdWVzdGlvbklkKCdwcm9qZWN0X2ludGVudCcpLCBmYWxzZSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChpc0dhdGVRdWVzdGlvbklkKCdmZWF0dXJlX3ByaW9yaXR5JyksIGZhbHNlKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGlzR2F0ZVF1ZXN0aW9uSWQoJ2xheWVyMV9zY29wZV9nYXRlJyksIGZhbHNlKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGlzR2F0ZVF1ZXN0aW9uSWQoJycpLCBmYWxzZSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNjZW5hcmlvIDIwOiBzZXRQZW5kaW5nR2F0ZSAvIGdldFBlbmRpbmdHYXRlIC8gY2xlYXJQZW5kaW5nR2F0ZSBsaWZlY3ljbGUgXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ3dyaXRlLWdhdGU6IHBlbmRpbmcgZ2F0ZSBsaWZlY3ljbGUgKHNldCwgZ2V0LCBjbGVhciknLCAoKSA9PiB7XG4gIGNsZWFyRGlzY3Vzc2lvbkZsb3dTdGF0ZShwcm9jZXNzLmN3ZCgpKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGdldFBlbmRpbmdHYXRlKCksIG51bGwsICdzdGFydHMgbnVsbCcpO1xuXG4gIHNldFBlbmRpbmdHYXRlKCdkZXB0aF92ZXJpZmljYXRpb24nLCBwcm9jZXNzLmN3ZCgpKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGdldFBlbmRpbmdHYXRlKCksICdkZXB0aF92ZXJpZmljYXRpb24nLCAnc2V0IGNvcnJlY3RseScpO1xuXG4gIGNsZWFyUGVuZGluZ0dhdGUocHJvY2Vzcy5jd2QoKSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChnZXRQZW5kaW5nR2F0ZSgpLCBudWxsLCAnY2xlYXJlZCBjb3JyZWN0bHknKTtcblxuICAvLyBjbGVhckRpc2N1c3Npb25GbG93U3RhdGUgYWxzbyBjbGVhcnMgcGVuZGluZyBnYXRlXG4gIHNldFBlbmRpbmdHYXRlKCdkZXB0aF92ZXJpZmljYXRpb25fTTAwMicsIHByb2Nlc3MuY3dkKCkpO1xuICBjbGVhckRpc2N1c3Npb25GbG93U3RhdGUocHJvY2Vzcy5jd2QoKSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChnZXRQZW5kaW5nR2F0ZSgpLCBudWxsLCAnY2xlYXJEaXNjdXNzaW9uRmxvd1N0YXRlIGNsZWFycyBwZW5kaW5nIGdhdGUnKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2NlbmFyaW8gMjE6IHNob3VsZEJsb2NrUGVuZGluZ0dhdGUgYmxvY2tzIG5vbi1zYWZlIHRvb2xzIHdoZW4gZ2F0ZSBpcyBwZW5kaW5nIFx1MjUwMFx1MjUwMFxuXG50ZXN0KCd3cml0ZS1nYXRlOiBzaG91bGRCbG9ja1BlbmRpbmdHYXRlIGJsb2NrcyB3cml0ZS9lZGl0IGR1cmluZyBwZW5kaW5nIGdhdGUnLCAoKSA9PiB7XG4gIGNsZWFyRGlzY3Vzc2lvbkZsb3dTdGF0ZShwcm9jZXNzLmN3ZCgpKTtcbiAgc2V0UGVuZGluZ0dhdGUoJ2RlcHRoX3ZlcmlmaWNhdGlvbicsIHByb2Nlc3MuY3dkKCkpO1xuXG4gIC8vIHdyaXRlIHNob3VsZCBiZSBibG9ja2VkIGR1cmluZyBkaXNjdXNzaW9uXG4gIGNvbnN0IHdyaXRlUmVzdWx0ID0gc2hvdWxkQmxvY2tQZW5kaW5nR2F0ZSgnd3JpdGUnLCAnTTAwMScsIGZhbHNlKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHdyaXRlUmVzdWx0LmJsb2NrLCB0cnVlLCAnd3JpdGUgc2hvdWxkIGJlIGJsb2NrZWQnKTtcbiAgYXNzZXJ0Lm9rKHdyaXRlUmVzdWx0LnJlYXNvbiEuaW5jbHVkZXMoJ2RlcHRoX3ZlcmlmaWNhdGlvbicpLCAncmVhc29uIG1lbnRpb25zIHRoZSBnYXRlJyk7XG5cbiAgLy8gZWRpdCBzaG91bGQgYmUgYmxvY2tlZFxuICBjb25zdCBlZGl0UmVzdWx0ID0gc2hvdWxkQmxvY2tQZW5kaW5nR2F0ZSgnZWRpdCcsICdNMDAxJywgZmFsc2UpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoZWRpdFJlc3VsdC5ibG9jaywgdHJ1ZSwgJ2VkaXQgc2hvdWxkIGJlIGJsb2NrZWQnKTtcblxuICAvLyBnc2QgdG9vbHMgc2hvdWxkIGJlIGJsb2NrZWRcbiAgY29uc3QgZ3NkUmVzdWx0ID0gc2hvdWxkQmxvY2tQZW5kaW5nR2F0ZSgnZ3NkX3BsYW5fbWlsZXN0b25lJywgJ00wMDEnLCBmYWxzZSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChnc2RSZXN1bHQuYmxvY2ssIHRydWUsICdnc2QgdG9vbHMgc2hvdWxkIGJlIGJsb2NrZWQnKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2NlbmFyaW8gMjI6IHNob3VsZEJsb2NrUGVuZGluZ0dhdGUgYWxsb3dzIG9ubHkgcmUtYXNraW5nIHdoZW4gZ2F0ZSBpcyBwZW5kaW5nIFx1MjUwMFx1MjUwMFxuXG50ZXN0KCd3cml0ZS1nYXRlOiBzaG91bGRCbG9ja1BlbmRpbmdHYXRlIGJsb2NrcyByZWFkLW9ubHkgdG9vbHMgYW5kIGFsbG93cyBhc2tfdXNlcl9xdWVzdGlvbnMgZHVyaW5nIHBlbmRpbmcgZ2F0ZScsICgpID0+IHtcbiAgY2xlYXJEaXNjdXNzaW9uRmxvd1N0YXRlKHByb2Nlc3MuY3dkKCkpO1xuICBzZXRQZW5kaW5nR2F0ZSgnZGVwdGhfdmVyaWZpY2F0aW9uJywgcHJvY2Vzcy5jd2QoKSk7XG5cbiAgLy8gYXNrX3VzZXJfcXVlc3Rpb25zIGlzIGFsd2F5cyBzYWZlIChtb2RlbCBuZWVkcyB0byByZS1hc2spXG4gIGFzc2VydC5zdHJpY3RFcXVhbChzaG91bGRCbG9ja1BlbmRpbmdHYXRlKCdhc2tfdXNlcl9xdWVzdGlvbnMnLCAnTTAwMScpLmJsb2NrLCBmYWxzZSk7XG4gIC8vIHJlYWQtb25seSB0b29scyBhcmUgYmxvY2tlZCBzbyB0aGUgdXNlci1mYWNpbmcgcXVlc3Rpb24gcmVtYWlucyB2aXNpYmxlXG4gIGFzc2VydC5zdHJpY3RFcXVhbChzaG91bGRCbG9ja1BlbmRpbmdHYXRlKCdyZWFkJywgJ00wMDEnKS5ibG9jaywgdHJ1ZSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChzaG91bGRCbG9ja1BlbmRpbmdHYXRlKCdncmVwJywgJ00wMDEnKS5ibG9jaywgdHJ1ZSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChzaG91bGRCbG9ja1BlbmRpbmdHYXRlKCdnbG9iJywgJ00wMDEnKS5ibG9jaywgdHJ1ZSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChzaG91bGRCbG9ja1BlbmRpbmdHYXRlKCdscycsICdNMDAxJykuYmxvY2ssIHRydWUpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTY2VuYXJpbyAyMzogc2hvdWxkQmxvY2tQZW5kaW5nR2F0ZSBzdGlsbCBibG9ja3Mgd2hlbiB0aGUgc2Vzc2lvbiBpcyBhbWJpZ3VvdXMgXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ3dyaXRlLWdhdGU6IHNob3VsZEJsb2NrUGVuZGluZ0dhdGUgYmxvY2tzIG91dHNpZGUgZGlzY3Vzc2lvbiB3aGVuIGEgZ2F0ZSBpcyBwZW5kaW5nJywgKCkgPT4ge1xuICBjbGVhckRpc2N1c3Npb25GbG93U3RhdGUocHJvY2Vzcy5jd2QoKSk7XG4gIHNldFBlbmRpbmdHYXRlKCdkZXB0aF92ZXJpZmljYXRpb24nLCBwcm9jZXNzLmN3ZCgpKTtcblxuICAvLyBObyBtaWxlc3RvbmVJZCBhbmQgbm8gcXVldWUgcGhhc2UgXHUyMDE0IHN0aWxsIGJsb2NrIGJlY2F1c2UgdGhlIGdhdGUgaXMgcGVuZGluZ1xuICBjb25zdCByZXN1bHQgPSBzaG91bGRCbG9ja1BlbmRpbmdHYXRlKCd3cml0ZScsIG51bGwsIGZhbHNlKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5ibG9jaywgdHJ1ZSwgJ3Nob3VsZCBibG9jayBldmVuIHdoZW4gbWlsZXN0b25lSWQgaXMgbnVsbCcpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTY2VuYXJpbyAyNDogc2hvdWxkQmxvY2tQZW5kaW5nR2F0ZSBibG9ja3MgaW4gcXVldWUgbW9kZSBcdTI1MDBcdTI1MDBcblxudGVzdCgnd3JpdGUtZ2F0ZTogc2hvdWxkQmxvY2tQZW5kaW5nR2F0ZSBibG9ja3MgaW4gcXVldWUgbW9kZSB3aGVuIGdhdGUgaXMgcGVuZGluZycsICgpID0+IHtcbiAgY2xlYXJEaXNjdXNzaW9uRmxvd1N0YXRlKHByb2Nlc3MuY3dkKCkpO1xuICBzZXRRdWV1ZVBoYXNlQWN0aXZlKHRydWUsIHByb2Nlc3MuY3dkKCkpO1xuICBzZXRQZW5kaW5nR2F0ZSgnZGVwdGhfdmVyaWZpY2F0aW9uJywgcHJvY2Vzcy5jd2QoKSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gc2hvdWxkQmxvY2tQZW5kaW5nR2F0ZSgnd3JpdGUnLCBudWxsLCB0cnVlKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5ibG9jaywgdHJ1ZSwgJ3Nob3VsZCBibG9jayBpbiBxdWV1ZSBtb2RlJyk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNjZW5hcmlvIDI1OiBzaG91bGRCbG9ja1BlbmRpbmdHYXRlQmFzaCBibG9ja3MgcmVhZC1vbmx5IGNvbW1hbmRzIFx1MjUwMFx1MjUwMFxuXG50ZXN0KCd3cml0ZS1nYXRlOiBzaG91bGRCbG9ja1BlbmRpbmdHYXRlQmFzaCBibG9ja3MgcmVhZC1vbmx5IGNvbW1hbmRzIGR1cmluZyBwZW5kaW5nIGdhdGUnLCAoKSA9PiB7XG4gIGNsZWFyRGlzY3Vzc2lvbkZsb3dTdGF0ZShwcm9jZXNzLmN3ZCgpKTtcbiAgc2V0UGVuZGluZ0dhdGUoJ2RlcHRoX3ZlcmlmaWNhdGlvbicsIHByb2Nlc3MuY3dkKCkpO1xuXG4gIGFzc2VydC5zdHJpY3RFcXVhbChzaG91bGRCbG9ja1BlbmRpbmdHYXRlQmFzaCgnY2F0IGZpbGUudHh0JywgJ00wMDEnKS5ibG9jaywgdHJ1ZSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChzaG91bGRCbG9ja1BlbmRpbmdHYXRlQmFzaCgnZ2l0IGxvZyAtLW9uZWxpbmUnLCAnTTAwMScpLmJsb2NrLCB0cnVlKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHNob3VsZEJsb2NrUGVuZGluZ0dhdGVCYXNoKCdncmVwIC1yIHBhdHRlcm4gLicsICdNMDAxJykuYmxvY2ssIHRydWUpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoc2hvdWxkQmxvY2tQZW5kaW5nR2F0ZUJhc2goJ2xzIC1sYScsICdNMDAxJykuYmxvY2ssIHRydWUpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTY2VuYXJpbyAyNjogc2hvdWxkQmxvY2tQZW5kaW5nR2F0ZUJhc2ggYmxvY2tzIG11dGF0aW5nIGNvbW1hbmRzIFx1MjUwMFx1MjUwMFxuXG50ZXN0KCd3cml0ZS1nYXRlOiBzaG91bGRCbG9ja1BlbmRpbmdHYXRlQmFzaCBibG9ja3MgbXV0YXRpbmcgY29tbWFuZHMgZHVyaW5nIHBlbmRpbmcgZ2F0ZScsICgpID0+IHtcbiAgY2xlYXJEaXNjdXNzaW9uRmxvd1N0YXRlKHByb2Nlc3MuY3dkKCkpO1xuICBzZXRQZW5kaW5nR2F0ZSgnZGVwdGhfdmVyaWZpY2F0aW9uJywgcHJvY2Vzcy5jd2QoKSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gc2hvdWxkQmxvY2tQZW5kaW5nR2F0ZUJhc2goJ25wbSBydW4gYnVpbGQnLCAnTTAwMScpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmJsb2NrLCB0cnVlLCAnbXV0YXRpbmcgYmFzaCBzaG91bGQgYmUgYmxvY2tlZCcpO1xuICBhc3NlcnQub2socmVzdWx0LnJlYXNvbiEuaW5jbHVkZXMoJ2RlcHRoX3ZlcmlmaWNhdGlvbicpKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2NlbmFyaW8gMjc6IG5vIHBlbmRpbmcgZ2F0ZSBtZWFucyBubyBibG9ja2luZyBcdTI1MDBcdTI1MDBcblxudGVzdCgnd3JpdGUtZ2F0ZTogbm8gcGVuZGluZyBnYXRlIG1lYW5zIG5vIGJsb2NraW5nJywgKCkgPT4ge1xuICBjbGVhckRpc2N1c3Npb25GbG93U3RhdGUocHJvY2Vzcy5jd2QoKSk7XG5cbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHNob3VsZEJsb2NrUGVuZGluZ0dhdGUoJ3dyaXRlJywgJ00wMDEnKS5ibG9jaywgZmFsc2UpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoc2hvdWxkQmxvY2tQZW5kaW5nR2F0ZUJhc2goJ25wbSBydW4gYnVpbGQnLCAnTTAwMScpLmJsb2NrLCBmYWxzZSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNjZW5hcmlvIDI4OiByZXNldFdyaXRlR2F0ZVN0YXRlIGNsZWFycyBwZW5kaW5nIGdhdGUgXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ3dyaXRlLWdhdGU6IHJlc2V0V3JpdGVHYXRlU3RhdGUgY2xlYXJzIHBlbmRpbmcgZ2F0ZScsICgpID0+IHtcbiAgc2V0UGVuZGluZ0dhdGUoJ2RlcHRoX3ZlcmlmaWNhdGlvbicsIHByb2Nlc3MuY3dkKCkpO1xuICByZXNldFdyaXRlR2F0ZVN0YXRlKHByb2Nlc3MuY3dkKCkpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoZ2V0UGVuZGluZ0dhdGUoKSwgbnVsbCk7XG59KTtcblxudGVzdCgnd3JpdGUtZ2F0ZTogaW4tbWVtb3J5IHN0YXRlIGlzIHNjb3BlZCBieSBiYXNlUGF0aCcsICgpID0+IHtcbiAgY29uc3Qgd29ya3NwYWNlQSA9IGpvaW4odG1wZGlyKCksIGBnc2Qtd3JpdGUtZ2F0ZS1pc29sYXRpb24tYS0ke3JhbmRvbVVVSUQoKX1gKTtcbiAgY29uc3Qgd29ya3NwYWNlQiA9IGpvaW4odG1wZGlyKCksIGBnc2Qtd3JpdGUtZ2F0ZS1pc29sYXRpb24tYi0ke3JhbmRvbVVVSUQoKX1gKTtcblxuICB0cnkge1xuICAgIGNsZWFyRGlzY3Vzc2lvbkZsb3dTdGF0ZSh3b3Jrc3BhY2VBKTtcbiAgICBjbGVhckRpc2N1c3Npb25GbG93U3RhdGUod29ya3NwYWNlQik7XG5cbiAgICBzZXRQZW5kaW5nR2F0ZSgnZGVwdGhfdmVyaWZpY2F0aW9uX003NzcnLCB3b3Jrc3BhY2VBKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoZ2V0UGVuZGluZ0dhdGUod29ya3NwYWNlQSksICdkZXB0aF92ZXJpZmljYXRpb25fTTc3NycsICd3b3Jrc3BhY2UgQSBzaG91bGQgc2VlIGl0cyBwZW5kaW5nIGdhdGUnKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoZ2V0UGVuZGluZ0dhdGUod29ya3NwYWNlQiksIG51bGwsICd3b3Jrc3BhY2UgQiBzaG91bGQgbm90IHNlZSB3b3Jrc3BhY2UgQSBwZW5kaW5nIGdhdGUnKTtcblxuICAgIGNsZWFyUGVuZGluZ0dhdGUod29ya3NwYWNlQSk7XG4gICAgc2V0UXVldWVQaGFzZUFjdGl2ZSh0cnVlLCB3b3Jrc3BhY2VBKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoaXNRdWV1ZVBoYXNlQWN0aXZlKHdvcmtzcGFjZUEpLCB0cnVlLCAnd29ya3NwYWNlIEEgc2hvdWxkIHNlZSBxdWV1ZSBtb2RlIGFjdGl2ZScpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChpc1F1ZXVlUGhhc2VBY3RpdmUod29ya3NwYWNlQiksIGZhbHNlLCAnd29ya3NwYWNlIEIgc2hvdWxkIG5vdCBzZWUgd29ya3NwYWNlIEEgcXVldWUgbW9kZScpO1xuXG4gICAgbWFya0RlcHRoVmVyaWZpZWQoJ003NzcnLCB3b3Jrc3BhY2VBKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoaXNNaWxlc3RvbmVEZXB0aFZlcmlmaWVkKCdNNzc3Jywgd29ya3NwYWNlQSksIHRydWUsICd3b3Jrc3BhY2UgQSBzaG91bGQgc2VlIGl0cyB2ZXJpZmllZCBtaWxlc3RvbmUnKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoaXNNaWxlc3RvbmVEZXB0aFZlcmlmaWVkKCdNNzc3Jywgd29ya3NwYWNlQiksIGZhbHNlLCAnd29ya3NwYWNlIEIgc2hvdWxkIG5vdCBzZWUgd29ya3NwYWNlIEEgbWlsZXN0b25lIHZlcmlmaWNhdGlvbicpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChpc0RlcHRoVmVyaWZpZWQod29ya3NwYWNlQiksIGZhbHNlLCAnd29ya3NwYWNlIEIgc2hvdWxkIGhhdmUgbm8gdmVyaWZpZWQgZGVwdGggc3RhdGUnKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhckRpc2N1c3Npb25GbG93U3RhdGUod29ya3NwYWNlQSk7XG4gICAgY2xlYXJEaXNjdXNzaW9uRmxvd1N0YXRlKHdvcmtzcGFjZUIpO1xuICAgIHJtU3luYyh3b3Jrc3BhY2VBLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgcm1TeW5jKHdvcmtzcGFjZUIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTdGFuZGFyZCBvcHRpb25zIGZpeHR1cmUgdXNlZCBhY3Jvc3MgZGVwdGggY29uZmlybWF0aW9uIHRlc3RzIFx1MjUwMFx1MjUwMFxuXG5jb25zdCBTVEFOREFSRF9PUFRJT05TID0gW1xuICB7IGxhYmVsOiAnWWVzLCB5b3UgZ290IGl0IChSZWNvbW1lbmRlZCknIH0sXG4gIHsgbGFiZWw6ICdOb3QgcXVpdGUgXHUyMDE0IGxldCBtZSBjbGFyaWZ5JyB9LFxuXTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNjZW5hcmlvIDExOiBhY2NlcHRzIGZpcnN0IG9wdGlvbiAoY29uZmlybWF0aW9uKSB3aXRoIHN0cnVjdHVyYWwgdmFsaWRhdGlvbiBcdTI1MDBcdTI1MDBcblxudGVzdCgnd3JpdGUtZ2F0ZTogaXNEZXB0aENvbmZpcm1hdGlvbkFuc3dlciBhY2NlcHRzIGZpcnN0IG9wdGlvbiB3aXRoIG9wdGlvbnMgcHJlc2VudCcsICgpID0+IHtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgIGlzRGVwdGhDb25maXJtYXRpb25BbnN3ZXIoJ1llcywgeW91IGdvdCBpdCAoUmVjb21tZW5kZWQpJywgU1RBTkRBUkRfT1BUSU9OUyksXG4gICAgdHJ1ZSxcbiAgICAnc2hvdWxkIGFjY2VwdCBleGFjdCBtYXRjaCBvZiBmaXJzdCBvcHRpb24gbGFiZWwnLFxuICApO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTY2VuYXJpbyAxMjogcmVqZWN0cyBzZWNvbmQgb3B0aW9uIChkZWNsaW5lKSBcdTI1MDBcdTI1MDBcblxudGVzdCgnd3JpdGUtZ2F0ZTogaXNEZXB0aENvbmZpcm1hdGlvbkFuc3dlciByZWplY3RzIGRlY2xpbmUgb3B0aW9uJywgKCkgPT4ge1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoXG4gICAgaXNEZXB0aENvbmZpcm1hdGlvbkFuc3dlcignTm90IHF1aXRlIFx1MjAxNCBsZXQgbWUgY2xhcmlmeScsIFNUQU5EQVJEX09QVElPTlMpLFxuICAgIGZhbHNlLFxuICAgICdzaG91bGQgcmVqZWN0IHRoZSBjbGFyaWZpY2F0aW9uIG9wdGlvbicsXG4gICk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNjZW5hcmlvIDEzOiByZWplY3RzIFwiTm9uZSBvZiB0aGUgYWJvdmVcIiBcdTI1MDBcdTI1MDBcblxudGVzdCgnd3JpdGUtZ2F0ZTogaXNEZXB0aENvbmZpcm1hdGlvbkFuc3dlciByZWplY3RzIE5vbmUgb2YgdGhlIGFib3ZlJywgKCkgPT4ge1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoXG4gICAgaXNEZXB0aENvbmZpcm1hdGlvbkFuc3dlcignTm9uZSBvZiB0aGUgYWJvdmUnLCBTVEFOREFSRF9PUFRJT05TKSxcbiAgICBmYWxzZSxcbiAgICAnc2hvdWxkIHJlamVjdCBOb25lIG9mIHRoZSBhYm92ZScsXG4gICk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNjZW5hcmlvIDE0OiByZWplY3RzIGdhcmJhZ2UvZW1wdHkgaW5wdXQgXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ3dyaXRlLWdhdGU6IGlzRGVwdGhDb25maXJtYXRpb25BbnN3ZXIgcmVqZWN0cyBnYXJiYWdlIGFuZCBlZGdlIGNhc2VzJywgKCkgPT4ge1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoaXNEZXB0aENvbmZpcm1hdGlvbkFuc3dlcignZGlzY29yZCcsIFNUQU5EQVJEX09QVElPTlMpLCBmYWxzZSwgJ2dhcmJhZ2Ugc3RyaW5nJyk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChpc0RlcHRoQ29uZmlybWF0aW9uQW5zd2VyKCcnLCBTVEFOREFSRF9PUFRJT05TKSwgZmFsc2UsICdlbXB0eSBzdHJpbmcnKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGlzRGVwdGhDb25maXJtYXRpb25BbnN3ZXIodW5kZWZpbmVkLCBTVEFOREFSRF9PUFRJT05TKSwgZmFsc2UsICd1bmRlZmluZWQnKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGlzRGVwdGhDb25maXJtYXRpb25BbnN3ZXIobnVsbCwgU1RBTkRBUkRfT1BUSU9OUyksIGZhbHNlLCAnbnVsbCcpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoaXNEZXB0aENvbmZpcm1hdGlvbkFuc3dlcig0MiwgU1RBTkRBUkRfT1BUSU9OUyksIGZhbHNlLCAnbnVtYmVyJyk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNjZW5hcmlvIDE1OiBoYW5kbGVzIGFycmF5LXdyYXBwZWQgc2VsZWN0aW9uIFx1MjUwMFx1MjUwMFxuXG50ZXN0KCd3cml0ZS1nYXRlOiBpc0RlcHRoQ29uZmlybWF0aW9uQW5zd2VyIGhhbmRsZXMgYXJyYXktd3JhcHBlZCBzZWxlY3RlZCB2YWx1ZScsICgpID0+IHtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgIGlzRGVwdGhDb25maXJtYXRpb25BbnN3ZXIoWydZZXMsIHlvdSBnb3QgaXQgKFJlY29tbWVuZGVkKSddLCBTVEFOREFSRF9PUFRJT05TKSxcbiAgICB0cnVlLFxuICAgICdzaG91bGQgYWNjZXB0IGFycmF5LXdyYXBwZWQgY29uZmlybWF0aW9uJyxcbiAgKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgIGlzRGVwdGhDb25maXJtYXRpb25BbnN3ZXIoWydOb3QgcXVpdGUgXHUyMDE0IGxldCBtZSBjbGFyaWZ5J10sIFNUQU5EQVJEX09QVElPTlMpLFxuICAgIGZhbHNlLFxuICAgICdzaG91bGQgcmVqZWN0IGFycmF5LXdyYXBwZWQgZGVjbGluZScsXG4gICk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChcbiAgICBpc0RlcHRoQ29uZmlybWF0aW9uQW5zd2VyKFtdLCBTVEFOREFSRF9PUFRJT05TKSxcbiAgICBmYWxzZSxcbiAgICAnc2hvdWxkIHJlamVjdCBlbXB0eSBhcnJheScsXG4gICk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNjZW5hcmlvIDE2OiByZWplY3RzIGZyZWUtZm9ybSBcIk90aGVyXCIgdGV4dCB0aGF0IGNvbnRhaW5zIFwiKFJlY29tbWVuZGVkKVwiIFx1MjUwMFx1MjUwMFxuXG50ZXN0KCd3cml0ZS1nYXRlOiBpc0RlcHRoQ29uZmlybWF0aW9uQW5zd2VyIHJlamVjdHMgZnJlZS1mb3JtIHRleHQgY29udGFpbmluZyBSZWNvbW1lbmRlZCcsICgpID0+IHtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgIGlzRGVwdGhDb25maXJtYXRpb25BbnN3ZXIoJ0kgdGhpbmsgdGhpcyBpcyBmaW5lIChSZWNvbW1lbmRlZCknLCBTVEFOREFSRF9PUFRJT05TKSxcbiAgICBmYWxzZSxcbiAgICAnZnJlZS1mb3JtIHRleHQgd2l0aCAoUmVjb21tZW5kZWQpIHN1YnN0cmluZyBtdXN0IG5vdCB1bmxvY2sgZ2F0ZScsXG4gICk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChcbiAgICBpc0RlcHRoQ29uZmlybWF0aW9uQW5zd2VyKCcoUmVjb21tZW5kZWQpJywgU1RBTkRBUkRfT1BUSU9OUyksXG4gICAgZmFsc2UsXG4gICAgJ2JhcmUgKFJlY29tbWVuZGVkKSBzdHJpbmcgbXVzdCBub3QgdW5sb2NrIGdhdGUnLFxuICApO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTY2VuYXJpbyAxNzogd29ya3Mgd2l0aCBjaGFuZ2VkIGxhYmVsIHRleHQgKGRlY291cGxlZCBmcm9tIHNwZWNpZmljIGNvcHkpIFx1MjUwMFx1MjUwMFxuXG50ZXN0KCd3cml0ZS1nYXRlOiBpc0RlcHRoQ29uZmlybWF0aW9uQW5zd2VyIHdvcmtzIHdpdGggZGlmZmVyZW50IGxhYmVsIHRleHQnLCAoKSA9PiB7XG4gIGNvbnN0IGN1c3RvbU9wdGlvbnMgPSBbXG4gICAgeyBsYWJlbDogJ0xvb2tzIGdvb2QsIHByb2NlZWQnIH0sXG4gICAgeyBsYWJlbDogJ05lZWRzIG1vcmUgZGlzY3Vzc2lvbicgfSxcbiAgXTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgIGlzRGVwdGhDb25maXJtYXRpb25BbnN3ZXIoJ0xvb2tzIGdvb2QsIHByb2NlZWQnLCBjdXN0b21PcHRpb25zKSxcbiAgICB0cnVlLFxuICAgICdzaG91bGQgYWNjZXB0IGZpcnN0IG9wdGlvbiByZWdhcmRsZXNzIG9mIGxhYmVsIHRleHQnLFxuICApO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoXG4gICAgaXNEZXB0aENvbmZpcm1hdGlvbkFuc3dlcignTmVlZHMgbW9yZSBkaXNjdXNzaW9uJywgY3VzdG9tT3B0aW9ucyksXG4gICAgZmFsc2UsXG4gICAgJ3Nob3VsZCByZWplY3Qgc2Vjb25kIG9wdGlvbicsXG4gICk7XG4gIC8vIE9sZCBsYWJlbCBzaG91bGQgTk9UIHdvcmsgd2l0aCBuZXcgb3B0aW9uc1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoXG4gICAgaXNEZXB0aENvbmZpcm1hdGlvbkFuc3dlcignWWVzLCB5b3UgZ290IGl0IChSZWNvbW1lbmRlZCknLCBjdXN0b21PcHRpb25zKSxcbiAgICBmYWxzZSxcbiAgICAnb2xkIGxhYmVsIHRleHQgc2hvdWxkIG5vdCBtYXRjaCBuZXcgb3B0aW9ucycsXG4gICk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNjZW5hcmlvIDE4OiBmYWlsLWNsb3NlZCB3aGVuIG9wdGlvbnMgbm90IGF2YWlsYWJsZSAoIzQ5NTApIFx1MjUwMFx1MjUwMFxuXG50ZXN0KCd3cml0ZS1nYXRlOiBpc0RlcHRoQ29uZmlybWF0aW9uQW5zd2VyIGZhaWxzIGNsb3NlZCB3aGVuIG9wdGlvbnMgYXJlIG1pc3NpbmcgKCM0OTUwKScsICgpID0+IHtcbiAgLy8gQWZ0ZXIgIzQ5NTAgdGhlIHN1YnN0cmluZyBmYWxsYmFjayB3YXMgcmVtb3ZlZC4gV2l0aG91dCBvcHRpb25zIHRoZSBnYXRlXG4gIC8vIGNhbiBuZXZlciBiZSB1bmxvY2tlZCBcdTIwMTQgZXZlcnkgaW5wdXQgbXVzdCByZXR1cm4gZmFsc2UuXG4gIGFzc2VydC5zdHJpY3RFcXVhbChcbiAgICBpc0RlcHRoQ29uZmlybWF0aW9uQW5zd2VyKCdZZXMsIHlvdSBnb3QgaXQgKFJlY29tbWVuZGVkKScpLFxuICAgIGZhbHNlLFxuICAgICduby1vcHRpb25zICsgUmVjb21tZW5kZWQgc3Vic3RyaW5nIG11c3QgTk9UIHVubG9jayB0aGUgZ2F0ZScsXG4gICk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChcbiAgICBpc0RlcHRoQ29uZmlybWF0aW9uQW5zd2VyKCdOb3QgcXVpdGUgXHUyMDE0IGxldCBtZSBjbGFyaWZ5JyksXG4gICAgZmFsc2UsXG4gICAgJ25vLW9wdGlvbnMgKyBub24tUmVjb21tZW5kZWQgbXVzdCBOT1QgdW5sb2NrIHRoZSBnYXRlJyxcbiAgKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2NlbmFyaW8gMjk6IGxvYWRXcml0ZUdhdGVTbmFwc2hvdCByZXR1cm5zIGNsZWFuIHN0YXRlIHdoZW4gcGVyc2lzdCBmaWxlIGRlbGV0ZWQgKCM0MzQzKSBcdTI1MDBcdTI1MDBcblxudGVzdCgnd3JpdGUtZ2F0ZTogbG9hZFdyaXRlR2F0ZVNuYXBzaG90IHJldHVybnMgZW1wdHkgZGVmYXVsdCB3aGVuIHBlcnNpc3QgZmlsZSBpcyBkZWxldGVkICgjNDM0MyknLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBqb2luKHRtcGRpcigpLCBgZ3NkLXdyaXRlLWdhdGUtNDM0My0ke3JhbmRvbVVVSUQoKX1gKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgJy5nc2QnLCAncnVudGltZScpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgY29uc3Qgc3RhdGVGaWxlUGF0aCA9IGpvaW4oYmFzZSwgJy5nc2QnLCAncnVudGltZScsICd3cml0ZS1nYXRlLXN0YXRlLmpzb24nKTtcbiAgY29uc3Qgb3JpZ2luYWxFbnYgPSBwcm9jZXNzLmVudi5HU0RfUEVSU0lTVF9XUklURV9HQVRFX1NUQVRFO1xuXG4gIHRyeSB7XG4gICAgcHJvY2Vzcy5lbnYuR1NEX1BFUlNJU1RfV1JJVEVfR0FURV9TVEFURSA9ICcxJztcblxuICAgIC8vIFdyaXRlIGEgc3RhdGUgZmlsZSB3aXRoIGEgcGVuZGluZyBnYXRlIGFuZCB2ZXJpZmllZCBtaWxlc3RvbmVcbiAgICB3cml0ZUZpbGVTeW5jKHN0YXRlRmlsZVBhdGgsIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIHZlcmlmaWVkRGVwdGhNaWxlc3RvbmVzOiBbJ00wMDEnXSxcbiAgICAgIGFjdGl2ZVF1ZXVlUGhhc2U6IGZhbHNlLFxuICAgICAgcGVuZGluZ0dhdGVJZDogJ2RlcHRoX3ZlcmlmaWNhdGlvbl9NMDAxJyxcbiAgICB9KSk7XG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoc3RhdGVGaWxlUGF0aCksICdwcmVjb25kaXRpb246IHN0YXRlIGZpbGUgZXhpc3RzJyk7XG5cbiAgICAvLyBXaGlsZSBmaWxlIGV4aXN0cywgc25hcHNob3QgcmVmbGVjdHMgaXRzIGNvbnRlbnRzXG4gICAgY29uc3QgYmVmb3JlRGVsZXRpb24gPSBsb2FkV3JpdGVHYXRlU25hcHNob3QoYmFzZSk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKGJlZm9yZURlbGV0aW9uLnBlbmRpbmdHYXRlSWQsICdkZXB0aF92ZXJpZmljYXRpb25fTTAwMScsICdwZW5kaW5nIGdhdGUgZnJvbSBmaWxlJyk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChiZWZvcmVEZWxldGlvbi52ZXJpZmllZERlcHRoTWlsZXN0b25lcywgWydNMDAxJ10sICd2ZXJpZmllZCBtaWxlc3RvbmVzIGZyb20gZmlsZScpO1xuXG4gICAgLy8gVXNlciBkZWxldGVzIHRoZSBzdGF0ZSBmaWxlIHRvIGNsZWFyIHRoZSBIQVJEIEJMT0NLXG4gICAgdW5saW5rU3luYyhzdGF0ZUZpbGVQYXRoKTtcbiAgICBhc3NlcnQub2soIWV4aXN0c1N5bmMoc3RhdGVGaWxlUGF0aCksICdzdGF0ZSBmaWxlIGRlbGV0ZWQnKTtcblxuICAgIC8vIEFmdGVyIGRlbGV0aW9uIGluIHBlcnNpc3QgbW9kZSwgc25hcHNob3Qgc2hvdWxkIGJlIGNsZWFuIChub3Qgc3RhbGUgaW4tbWVtb3J5KVxuICAgIGNvbnN0IGFmdGVyRGVsZXRpb24gPSBsb2FkV3JpdGVHYXRlU25hcHNob3QoYmFzZSk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKGFmdGVyRGVsZXRpb24ucGVuZGluZ0dhdGVJZCwgbnVsbCwgJ3BlbmRpbmdHYXRlSWQgY2xlYXJlZCBhZnRlciBmaWxlIGRlbGV0aW9uJyk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChhZnRlckRlbGV0aW9uLnZlcmlmaWVkRGVwdGhNaWxlc3RvbmVzLCBbXSwgJ3ZlcmlmaWVkRGVwdGhNaWxlc3RvbmVzIGNsZWFyZWQgYWZ0ZXIgZmlsZSBkZWxldGlvbicpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChhZnRlckRlbGV0aW9uLmFjdGl2ZVF1ZXVlUGhhc2UsIGZhbHNlLCAnYWN0aXZlUXVldWVQaGFzZSBjbGVhcmVkIGFmdGVyIGZpbGUgZGVsZXRpb24nKTtcblxuICAgIC8vIFRoZSBDT05URVhUIGFydGlmYWN0IGJsb2NrIGNoZWNrIG11c3QgYWxzbyByZXNvbHZlIHRvIHVuYmxvY2tlZCBhZnRlciBkZWxldGlvbit2ZXJpZmljYXRpb25cbiAgICAvLyAoc2ltdWxhdGUgdGhlIHJlLXZlcmlmeSBmbG93IHVzZXJzIHdvdWxkIGRvOiBkZWxldGUgXHUyMTkyIGRlcHRoIHZlcmlmeSBcdTIxOTIgc2F2ZSlcbiAgICBjb25zdCBzdGlsbEJsb2NrZWQgPSBzaG91bGRCbG9ja0NvbnRleHRBcnRpZmFjdFNhdmVJblNuYXBzaG90KGFmdGVyRGVsZXRpb24sICdDT05URVhUJywgJ00wMDEnLCBudWxsKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoc3RpbGxCbG9ja2VkLmJsb2NrLCB0cnVlLCAnc3RpbGwgYmxvY2tlZCB3aXRob3V0IG5ldyBkZXB0aCB2ZXJpZmljYXRpb24nKTtcblxuICAgIGNvbnN0IHZlcmlmaWVkU25hcHNob3QgPSB7XG4gICAgICAuLi5hZnRlckRlbGV0aW9uLFxuICAgICAgdmVyaWZpZWREZXB0aE1pbGVzdG9uZXM6IFsnTTAwMSddLFxuICAgIH07XG4gICAgY29uc3QgdW5ibG9ja2VkID0gc2hvdWxkQmxvY2tDb250ZXh0QXJ0aWZhY3RTYXZlSW5TbmFwc2hvdCh2ZXJpZmllZFNuYXBzaG90LCAnQ09OVEVYVCcsICdNMDAxJywgbnVsbCk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHVuYmxvY2tlZC5ibG9jaywgZmFsc2UsICd1bmJsb2NrZWQgYWZ0ZXIgZnJlc2ggZGVwdGggdmVyaWZpY2F0aW9uJyk7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKG9yaWdpbmFsRW52ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfUEVSU0lTVF9XUklURV9HQVRFX1NUQVRFO1xuICAgIH0gZWxzZSB7XG4gICAgICBwcm9jZXNzLmVudi5HU0RfUEVSU0lTVF9XUklURV9HQVRFX1NUQVRFID0gb3JpZ2luYWxFbnY7XG4gICAgfVxuICAgIGNsZWFyRGlzY3Vzc2lvbkZsb3dTdGF0ZShiYXNlKTtcbiAgICB0cnkge1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9IGNhdGNoIHsgLyogc3dhbGxvdyAqLyB9XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2NlbmFyaW8gMzA6IHdyaXRlLWdhdGUgcGVyc2lzdGVuY2UgcmVjcmVhdGVzIGRhbmdsaW5nIGV4dGVybmFsIC5nc2QgdGFyZ2V0IFx1MjUwMFx1MjUwMFxuXG50ZXN0KCd3cml0ZS1nYXRlOiByZXNldFdyaXRlR2F0ZVN0YXRlIHBlcnNpc3RzIHRocm91Z2ggZGFuZ2xpbmcgLmdzZCBzeW1saW5rJywgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gam9pbih0bXBkaXIoKSwgYGdzZC13cml0ZS1nYXRlLWRhbmdsaW5nLSR7cmFuZG9tVVVJRCgpfWApO1xuICBjb25zdCBleHRlcm5hbFN0YXRlID0gam9pbih0bXBkaXIoKSwgYGdzZC13cml0ZS1nYXRlLWV4dGVybmFsLSR7cmFuZG9tVVVJRCgpfWApO1xuICBjb25zdCBzdGF0ZUZpbGVQYXRoID0gam9pbihiYXNlLCAnLmdzZCcsICdydW50aW1lJywgJ3dyaXRlLWdhdGUtc3RhdGUuanNvbicpO1xuICBjb25zdCBvcmlnaW5hbEVudiA9IHByb2Nlc3MuZW52LkdTRF9QRVJTSVNUX1dSSVRFX0dBVEVfU1RBVEU7XG5cbiAgdHJ5IHtcbiAgICBwcm9jZXNzLmVudi5HU0RfUEVSU0lTVF9XUklURV9HQVRFX1NUQVRFID0gJzEnO1xuICAgIG1rZGlyU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBzeW1saW5rU3luYyhleHRlcm5hbFN0YXRlLCBqb2luKGJhc2UsICcuZ3NkJyksICdqdW5jdGlvbicpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChleGlzdHNTeW5jKGpvaW4oYmFzZSwgJy5nc2QnKSksIGZhbHNlLCAncHJlY29uZGl0aW9uOiAuZ3NkIHN5bWxpbmsgdGFyZ2V0IGlzIG1pc3NpbmcnKTtcblxuICAgIHJlc2V0V3JpdGVHYXRlU3RhdGUoYmFzZSk7XG5cbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhleHRlcm5hbFN0YXRlKSwgJ21pc3NpbmcgZXh0ZXJuYWwgc3RhdGUgdGFyZ2V0IHdhcyByZWNyZWF0ZWQnKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhzdGF0ZUZpbGVQYXRoKSwgJ3dyaXRlLWdhdGUgc25hcHNob3QgcGVyc2lzdGVkIHVuZGVyIC5nc2QvcnVudGltZScpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwobG9hZFdyaXRlR2F0ZVNuYXBzaG90KGJhc2UpLCB7XG4gICAgICB2ZXJpZmllZERlcHRoTWlsZXN0b25lczogW10sXG4gICAgICB2ZXJpZmllZEFwcHJvdmFsR2F0ZXM6IFtdLFxuICAgICAgYWN0aXZlUXVldWVQaGFzZTogZmFsc2UsXG4gICAgICBwZW5kaW5nR2F0ZUlkOiBudWxsLFxuICAgIH0pO1xuICB9IGZpbmFsbHkge1xuICAgIGlmIChvcmlnaW5hbEVudiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX1BFUlNJU1RfV1JJVEVfR0FURV9TVEFURTtcbiAgICB9IGVsc2Uge1xuICAgICAgcHJvY2Vzcy5lbnYuR1NEX1BFUlNJU1RfV1JJVEVfR0FURV9TVEFURSA9IG9yaWdpbmFsRW52O1xuICAgIH1cbiAgICBjbGVhckRpc2N1c3Npb25GbG93U3RhdGUoYmFzZSk7XG4gICAgdHJ5IHtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgICBybVN5bmMoZXh0ZXJuYWxTdGF0ZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2ggeyAvKiBzd2FsbG93ICovIH1cbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFZQSxPQUFPLFFBQVEsaUJBQWlCO0FBQ2hDLE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsZUFBZSxZQUFZLFlBQVksUUFBUSxtQkFBbUI7QUFDdEYsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QixTQUFTLGtCQUFrQjtBQUMzQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUVQLFVBQVUsTUFBTTtBQUNkLDJCQUF5QixRQUFRLElBQUksQ0FBQztBQUN4QyxDQUFDO0FBSUQsS0FBSyxvR0FBb0csTUFBTTtBQUM3RyxRQUFNLFNBQVM7QUFBQSxJQUNiO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRjtBQUNB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
