import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveDispatch } from "../auto-dispatch.js";
function makeIsolatedBase() {
  const base = join(tmpdir(), `gsd-deep-integration-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  return base;
}
function makeCtx(basePath, prefs, phase = "needs-discussion") {
  const state = {
    phase,
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: null,
    activeTask: null,
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [{ id: "M001", title: "Test", status: "active" }]
  };
  return {
    basePath,
    mid: "M001",
    midTitle: "Test",
    state,
    prefs,
    structuredQuestionsAvailable: "false"
  };
}
const capturedPreferencesMd = `---
planning_depth: deep
workflow_prefs_captured: true
commit_policy: per-task
branch_model: single
uat_dispatch: true
models:
  executor_class: balanced
phases:
  skip_research: false
---
`;
const validProjectMd = [
  "# Project",
  "",
  "## What This Is",
  "",
  "A test project.",
  "",
  "## Core Value",
  "",
  "Reliable dispatch behavior.",
  "",
  "## Current State",
  "",
  "Tests are exercising deep planning.",
  "",
  "## Architecture / Key Patterns",
  "",
  "Markdown artifacts drive stage gates.",
  "",
  "## Capability Contract",
  "",
  "See `.gsd/REQUIREMENTS.md`.",
  "",
  "## Milestone Sequence",
  "",
  "- [ ] M001: Test - exercise deep planning dispatch",
  ""
].join("\n");
const validRequirementsMd = [
  "# Requirements",
  "",
  "## Active",
  "",
  "### R001 - Dispatch valid artifacts",
  "- Class: core-capability",
  "- Status: active",
  "- Description: Valid artifacts allow deep-mode dispatch to advance.",
  "- Why it matters: Stage gates must not stall valid projects.",
  "- Source: test",
  "- Primary owning slice: M001/S01",
  "- Supporting slices: none",
  "- Validation: unmapped",
  "- Notes:",
  "",
  "## Validated",
  "",
  "## Deferred",
  "",
  "## Out of Scope",
  "",
  "## Traceability",
  "",
  "| ID | Class | Status | Primary owner | Supporting | Proof |",
  "|---|---|---|---|---|---|",
  "| R001 | core-capability | active | M001/S01 | none | unmapped |",
  "",
  "## Coverage Summary",
  "",
  "- Active requirements: 1",
  ""
].join("\n");
function writePreferences(base) {
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), capturedPreferencesMd);
}
function writeValidProject(base) {
  writeFileSync(join(base, ".gsd", "PROJECT.md"), validProjectMd);
}
function writeValidRequirements(base) {
  writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), validRequirementsMd);
}
test("integration: deep mode + needs-discussion + nothing captured \u2192 capture prefs then discuss-project", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  const prefs = { planning_depth: "deep" };
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch", `expected dispatch, got ${result.action}: ${JSON.stringify(result)}`);
  if (result.action === "dispatch") {
    assert.strictEqual(
      result.unitType,
      "discuss-project",
      "deep mode in needs-discussion must self-heal preferences before project discovery, not discuss milestone"
    );
  }
  const prefsContent = readFileSync(join(base, ".gsd", "PREFERENCES.md"), "utf-8");
  assert.match(prefsContent, /^workflow_prefs_captured:\s*true\s*$/m);
  assert.ok(existsSync(join(base, ".gsd", "runtime", "research-decision.json")));
});
test("integration: deep mode + pre-planning + nothing captured \u2192 capture prefs then discuss-project", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  const prefs = { planning_depth: "deep" };
  const result = await resolveDispatch(makeCtx(base, prefs, "pre-planning"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-project");
  }
  const prefsContent = readFileSync(join(base, ".gsd", "PREFERENCES.md"), "utf-8");
  assert.match(prefsContent, /^workflow_prefs_captured:\s*true\s*$/m);
});
test("integration: deep mode + prefs captured + no PROJECT.md \u2192 discuss-project", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  writePreferences(base);
  const prefs = { planning_depth: "deep" };
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-project");
  }
});
test("integration: deep mode + invalid PROJECT.md \u2192 discuss-project, not discuss-milestone", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  writePreferences(base);
  writeFileSync(join(base, ".gsd", "PROJECT.md"), "# Project\n");
  const prefs = { planning_depth: "deep" };
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-project");
  }
});
test("integration: deep mode + PROJECT.md + no REQUIREMENTS.md \u2192 discuss-requirements", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  writePreferences(base);
  writeValidProject(base);
  const prefs = { planning_depth: "deep" };
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-requirements");
  }
});
test("integration: deep mode + invalid REQUIREMENTS.md \u2192 discuss-requirements, not discuss-milestone", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  writePreferences(base);
  writeValidProject(base);
  writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), "# Requirements\n");
  const prefs = { planning_depth: "deep" };
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-requirements");
  }
});
test("integration: deep mode + REQUIREMENTS.md + no research-decision \u2192 discuss-milestone", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  writePreferences(base);
  writeValidProject(base);
  writeValidRequirements(base);
  const prefs = { planning_depth: "deep" };
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-milestone");
  }
  const decision = JSON.parse(readFileSync(join(base, ".gsd", "runtime", "research-decision.json"), "utf-8"));
  assert.equal(decision.decision, "skip");
  assert.equal(decision.reason, "missing-default-repair");
});
test("integration: deep mode + decision=research + research files missing \u2192 research-project", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  writePreferences(base);
  writeValidProject(base);
  writeValidRequirements(base);
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "runtime", "research-decision.json"),
    JSON.stringify({ decision: "research", source: "research-decision" })
  );
  const prefs = { planning_depth: "deep" };
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "research-project");
  }
});
test("integration: deep mode + research-project marker \u2192 stop, not discuss-milestone", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  writePreferences(base);
  writeValidProject(base);
  writeValidRequirements(base);
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "runtime", "research-decision.json"),
    JSON.stringify({ decision: "research", source: "research-decision" })
  );
  writeFileSync(join(base, ".gsd", "runtime", "research-project-inflight"), "{}\n");
  const prefs = { planning_depth: "deep" };
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "stop");
  if (result.action === "stop") {
    assert.match(result.reason, /research-project-inflight/);
  }
});
test("integration: deep mode + decision=research + dimension blocker \u2192 discuss-milestone", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  writePreferences(base);
  writeValidProject(base);
  writeValidRequirements(base);
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "runtime", "research-decision.json"),
    JSON.stringify({ decision: "research", source: "research-decision" })
  );
  mkdirSync(join(base, ".gsd", "research"), { recursive: true });
  for (const name of ["STACK.md", "FEATURES.md", "ARCHITECTURE.md"]) {
    writeFileSync(join(base, ".gsd", "research", name), "# done\n");
  }
  writeFileSync(join(base, ".gsd", "research", "PITFALLS-BLOCKER.md"), "# blocker\n");
  const prefs = { planning_depth: "deep" };
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(
      result.unitType,
      "discuss-milestone",
      "a dimension blocker should clear the project research gate"
    );
  }
});
test("integration: deep mode + decision=skip \u2192 falls through to discuss-milestone in needs-discussion", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  writePreferences(base);
  writeValidProject(base);
  writeValidRequirements(base);
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "runtime", "research-decision.json"),
    JSON.stringify({ decision: "skip" })
  );
  const prefs = { planning_depth: "deep" };
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(
      result.unitType,
      "discuss-milestone",
      "after all deep stage gates pass and user skipped research, milestone discussion should fire"
    );
  }
});
test("integration: deep mode + decision=<garbage> repairs to skip and discusses milestone", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  writePreferences(base);
  writeValidProject(base);
  writeValidRequirements(base);
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "runtime", "research-decision.json"),
    JSON.stringify({ decision: "garbage" })
  );
  const prefs = { planning_depth: "deep" };
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(
      result.unitType,
      "discuss-milestone",
      "malformed or unrecognized default research markers should repair to skip and advance"
    );
  }
  const decision = JSON.parse(readFileSync(join(base, ".gsd", "runtime", "research-decision.json"), "utf-8"));
  assert.equal(decision.decision, "skip");
  assert.equal(decision.reason, "malformed-default-repair");
});
test("integration: light mode (no prefs) + needs-discussion \u2192 discuss-milestone (unchanged behavior)", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  const result = await resolveDispatch(makeCtx(base, void 0, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-milestone");
  }
});
test("integration: light mode + planning_depth=light + needs-discussion \u2192 discuss-milestone", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  const prefs = { planning_depth: "light" };
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-milestone");
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kZWVwLW1vZGUtaW50ZWdyYXRpb24udGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NELTIgXHUyMDE0IERlZXAgcGxhbm5pbmcgbW9kZSBlbmQtdG8tZW5kIGRpc3BhdGNoIGNoYWluIGludGVncmF0aW9uIHRlc3QuXG4vL1xuLy8gVW5pdC1sZXZlbCB0ZXN0cyAoZGVlcC1wbGFubmluZy1tb2RlLWRpc3BhdGNoLnRlc3QudHMpIGludm9rZSBlYWNoXG4vLyBydWxlJ3MgbWF0Y2goKSBpbiBpc29sYXRpb24gYW5kIG1pc3Mgb3JkZXJpbmcgYnVncy4gVGhpcyB0ZXN0IGV4ZXJjaXNlc1xuLy8gcmVzb2x2ZURpc3BhdGNoIHdpdGggYWxsIHJ1bGVzIGxvYWRlZCBhbmQgdmVyaWZpZXMgdGhhdCwgaW4gZGVlcCBtb2RlLFxuLy8gdGhlIHByb2plY3QtbGV2ZWwgc3RhZ2UgZ2F0ZXMgZmlyZSBpbiB0aGUgY29ycmVjdCBvcmRlciBcdTIwMTQgZXZlbiB3aGVuXG4vLyBzdGF0ZS5waGFzZSBpcyBcIm5lZWRzLWRpc2N1c3Npb25cIiAod2hpY2ggcHJldmlvdXNseSBzaG9ydC1jaXJjdWl0ZWRcbi8vIHRvIGRpc2N1c3MtbWlsZXN0b25lIGJlZm9yZSBhbnkgZGVlcCBydWxlIGNvdWxkIHJ1bikuXG5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcblxuaW1wb3J0IHsgcmVzb2x2ZURpc3BhdGNoLCB0eXBlIERpc3BhdGNoQ29udGV4dCB9IGZyb20gXCIuLi9hdXRvLWRpc3BhdGNoLnRzXCI7XG5pbXBvcnQgdHlwZSB7IEdTRFN0YXRlIH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgdHlwZSB7IEdTRFByZWZlcmVuY2VzIH0gZnJvbSBcIi4uL3ByZWZlcmVuY2VzLnRzXCI7XG5cbmZ1bmN0aW9uIG1ha2VJc29sYXRlZEJhc2UoKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IGpvaW4odG1wZGlyKCksIGBnc2QtZGVlcC1pbnRlZ3JhdGlvbi0ke3JhbmRvbVVVSUQoKX1gKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gbWFrZUN0eChcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgcHJlZnM6IEdTRFByZWZlcmVuY2VzIHwgdW5kZWZpbmVkLFxuICBwaGFzZTogR1NEU3RhdGVbXCJwaGFzZVwiXSA9IFwibmVlZHMtZGlzY3Vzc2lvblwiLFxuKTogRGlzcGF0Y2hDb250ZXh0IHtcbiAgY29uc3Qgc3RhdGU6IEdTRFN0YXRlID0ge1xuICAgIHBoYXNlLFxuICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiB9LFxuICAgIGFjdGl2ZVNsaWNlOiBudWxsLFxuICAgIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgcmVjZW50RGVjaXNpb25zOiBbXSxcbiAgICBibG9ja2VyczogW10sXG4gICAgbmV4dEFjdGlvbjogXCJcIixcbiAgICByZWdpc3RyeTogW3sgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9XSxcbiAgfTtcbiAgcmV0dXJuIHtcbiAgICBiYXNlUGF0aCxcbiAgICBtaWQ6IFwiTTAwMVwiLFxuICAgIG1pZFRpdGxlOiBcIlRlc3RcIixcbiAgICBzdGF0ZSxcbiAgICBwcmVmcyxcbiAgICBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlOiBcImZhbHNlXCIsXG4gIH07XG59XG5cbi8vIFBSRUZFUkVOQ0VTLm1kIGZyb250bWF0dGVyIHRoYXQgc2F0aXNmaWVzIHRoZSB3b3JrZmxvdy1wcmVmZXJlbmNlcyBzdGFnZVxuLy8gZ2F0ZS4gVGhlIGRpc3BhdGNoIGxheWVyIGtleXMgb2ZmIHRoZSBleHBsaWNpdCBgd29ya2Zsb3dfcHJlZnNfY2FwdHVyZWRgXG4vLyBtYXJrZXIsIG5vdCBvbiBpbmRpdmlkdWFsIGtleSBwcmVzZW5jZSBcdTIwMTQgc2VlIGlzV29ya2Zsb3dQcmVmc0NhcHR1cmVkLlxuY29uc3QgY2FwdHVyZWRQcmVmZXJlbmNlc01kID0gYC0tLVxucGxhbm5pbmdfZGVwdGg6IGRlZXBcbndvcmtmbG93X3ByZWZzX2NhcHR1cmVkOiB0cnVlXG5jb21taXRfcG9saWN5OiBwZXItdGFza1xuYnJhbmNoX21vZGVsOiBzaW5nbGVcbnVhdF9kaXNwYXRjaDogdHJ1ZVxubW9kZWxzOlxuICBleGVjdXRvcl9jbGFzczogYmFsYW5jZWRcbnBoYXNlczpcbiAgc2tpcF9yZXNlYXJjaDogZmFsc2Vcbi0tLVxuYDtcblxuY29uc3QgdmFsaWRQcm9qZWN0TWQgPSBbXG4gIFwiIyBQcm9qZWN0XCIsXG4gIFwiXCIsXG4gIFwiIyMgV2hhdCBUaGlzIElzXCIsXG4gIFwiXCIsXG4gIFwiQSB0ZXN0IHByb2plY3QuXCIsXG4gIFwiXCIsXG4gIFwiIyMgQ29yZSBWYWx1ZVwiLFxuICBcIlwiLFxuICBcIlJlbGlhYmxlIGRpc3BhdGNoIGJlaGF2aW9yLlwiLFxuICBcIlwiLFxuICBcIiMjIEN1cnJlbnQgU3RhdGVcIixcbiAgXCJcIixcbiAgXCJUZXN0cyBhcmUgZXhlcmNpc2luZyBkZWVwIHBsYW5uaW5nLlwiLFxuICBcIlwiLFxuICBcIiMjIEFyY2hpdGVjdHVyZSAvIEtleSBQYXR0ZXJuc1wiLFxuICBcIlwiLFxuICBcIk1hcmtkb3duIGFydGlmYWN0cyBkcml2ZSBzdGFnZSBnYXRlcy5cIixcbiAgXCJcIixcbiAgXCIjIyBDYXBhYmlsaXR5IENvbnRyYWN0XCIsXG4gIFwiXCIsXG4gIFwiU2VlIGAuZ3NkL1JFUVVJUkVNRU5UUy5tZGAuXCIsXG4gIFwiXCIsXG4gIFwiIyMgTWlsZXN0b25lIFNlcXVlbmNlXCIsXG4gIFwiXCIsXG4gIFwiLSBbIF0gTTAwMTogVGVzdCAtIGV4ZXJjaXNlIGRlZXAgcGxhbm5pbmcgZGlzcGF0Y2hcIixcbiAgXCJcIixcbl0uam9pbihcIlxcblwiKTtcblxuY29uc3QgdmFsaWRSZXF1aXJlbWVudHNNZCA9IFtcbiAgXCIjIFJlcXVpcmVtZW50c1wiLFxuICBcIlwiLFxuICBcIiMjIEFjdGl2ZVwiLFxuICBcIlwiLFxuICBcIiMjIyBSMDAxIC0gRGlzcGF0Y2ggdmFsaWQgYXJ0aWZhY3RzXCIsXG4gIFwiLSBDbGFzczogY29yZS1jYXBhYmlsaXR5XCIsXG4gIFwiLSBTdGF0dXM6IGFjdGl2ZVwiLFxuICBcIi0gRGVzY3JpcHRpb246IFZhbGlkIGFydGlmYWN0cyBhbGxvdyBkZWVwLW1vZGUgZGlzcGF0Y2ggdG8gYWR2YW5jZS5cIixcbiAgXCItIFdoeSBpdCBtYXR0ZXJzOiBTdGFnZSBnYXRlcyBtdXN0IG5vdCBzdGFsbCB2YWxpZCBwcm9qZWN0cy5cIixcbiAgXCItIFNvdXJjZTogdGVzdFwiLFxuICBcIi0gUHJpbWFyeSBvd25pbmcgc2xpY2U6IE0wMDEvUzAxXCIsXG4gIFwiLSBTdXBwb3J0aW5nIHNsaWNlczogbm9uZVwiLFxuICBcIi0gVmFsaWRhdGlvbjogdW5tYXBwZWRcIixcbiAgXCItIE5vdGVzOlwiLFxuICBcIlwiLFxuICBcIiMjIFZhbGlkYXRlZFwiLFxuICBcIlwiLFxuICBcIiMjIERlZmVycmVkXCIsXG4gIFwiXCIsXG4gIFwiIyMgT3V0IG9mIFNjb3BlXCIsXG4gIFwiXCIsXG4gIFwiIyMgVHJhY2VhYmlsaXR5XCIsXG4gIFwiXCIsXG4gIFwifCBJRCB8IENsYXNzIHwgU3RhdHVzIHwgUHJpbWFyeSBvd25lciB8IFN1cHBvcnRpbmcgfCBQcm9vZiB8XCIsXG4gIFwifC0tLXwtLS18LS0tfC0tLXwtLS18LS0tfFwiLFxuICBcInwgUjAwMSB8IGNvcmUtY2FwYWJpbGl0eSB8IGFjdGl2ZSB8IE0wMDEvUzAxIHwgbm9uZSB8IHVubWFwcGVkIHxcIixcbiAgXCJcIixcbiAgXCIjIyBDb3ZlcmFnZSBTdW1tYXJ5XCIsXG4gIFwiXCIsXG4gIFwiLSBBY3RpdmUgcmVxdWlyZW1lbnRzOiAxXCIsXG4gIFwiXCIsXG5dLmpvaW4oXCJcXG5cIik7XG5cbmZ1bmN0aW9uIHdyaXRlUHJlZmVyZW5jZXMoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSwgY2FwdHVyZWRQcmVmZXJlbmNlc01kKTtcbn1cblxuZnVuY3Rpb24gd3JpdGVWYWxpZFByb2plY3QoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJQUk9KRUNULm1kXCIpLCB2YWxpZFByb2plY3RNZCk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlVmFsaWRSZXF1aXJlbWVudHMoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJSRVFVSVJFTUVOVFMubWRcIiksIHZhbGlkUmVxdWlyZW1lbnRzTWQpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmVncmVzc2lvbiB0ZXN0IGZvciBCMTogcnVsZSBvcmRlcmluZyBidWcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJpbnRlZ3JhdGlvbjogZGVlcCBtb2RlICsgbmVlZHMtZGlzY3Vzc2lvbiArIG5vdGhpbmcgY2FwdHVyZWQgXHUyMTkyIGNhcHR1cmUgcHJlZnMgdGhlbiBkaXNjdXNzLXByb2plY3RcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiB7IHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2gge30gfSk7XG5cbiAgY29uc3QgcHJlZnMgPSB7IHBsYW5uaW5nX2RlcHRoOiBcImRlZXBcIiB9IGFzIEdTRFByZWZlcmVuY2VzO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXNvbHZlRGlzcGF0Y2gobWFrZUN0eChiYXNlLCBwcmVmcywgXCJuZWVkcy1kaXNjdXNzaW9uXCIpKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5hY3Rpb24sIFwiZGlzcGF0Y2hcIiwgYGV4cGVjdGVkIGRpc3BhdGNoLCBnb3QgJHtyZXN1bHQuYWN0aW9ufTogJHtKU09OLnN0cmluZ2lmeShyZXN1bHQpfWApO1xuICBpZiAocmVzdWx0LmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiKSB7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgICAgcmVzdWx0LnVuaXRUeXBlLFxuICAgICAgXCJkaXNjdXNzLXByb2plY3RcIixcbiAgICAgIFwiZGVlcCBtb2RlIGluIG5lZWRzLWRpc2N1c3Npb24gbXVzdCBzZWxmLWhlYWwgcHJlZmVyZW5jZXMgYmVmb3JlIHByb2plY3QgZGlzY292ZXJ5LCBub3QgZGlzY3VzcyBtaWxlc3RvbmVcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IHByZWZzQ29udGVudCA9IHJlYWRGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLCBcInV0Zi04XCIpO1xuICBhc3NlcnQubWF0Y2gocHJlZnNDb250ZW50LCAvXndvcmtmbG93X3ByZWZzX2NhcHR1cmVkOlxccyp0cnVlXFxzKiQvbSk7XG4gIGFzc2VydC5vayhleGlzdHNTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiLCBcInJlc2VhcmNoLWRlY2lzaW9uLmpzb25cIikpKTtcbn0pO1xuXG50ZXN0KFwiaW50ZWdyYXRpb246IGRlZXAgbW9kZSArIHByZS1wbGFubmluZyArIG5vdGhpbmcgY2FwdHVyZWQgXHUyMTkyIGNhcHR1cmUgcHJlZnMgdGhlbiBkaXNjdXNzLXByb2plY3RcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiB7IHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2gge30gfSk7XG5cbiAgY29uc3QgcHJlZnMgPSB7IHBsYW5uaW5nX2RlcHRoOiBcImRlZXBcIiB9IGFzIEdTRFByZWZlcmVuY2VzO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXNvbHZlRGlzcGF0Y2gobWFrZUN0eChiYXNlLCBwcmVmcywgXCJwcmUtcGxhbm5pbmdcIikpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmFjdGlvbiwgXCJkaXNwYXRjaFwiKTtcbiAgaWYgKHJlc3VsdC5hY3Rpb24gPT09IFwiZGlzcGF0Y2hcIikge1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQudW5pdFR5cGUsIFwiZGlzY3Vzcy1wcm9qZWN0XCIpO1xuICB9XG4gIGNvbnN0IHByZWZzQ29udGVudCA9IHJlYWRGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLCBcInV0Zi04XCIpO1xuICBhc3NlcnQubWF0Y2gocHJlZnNDb250ZW50LCAvXndvcmtmbG93X3ByZWZzX2NhcHR1cmVkOlxccyp0cnVlXFxzKiQvbSk7XG59KTtcblxudGVzdChcImludGVncmF0aW9uOiBkZWVwIG1vZGUgKyBwcmVmcyBjYXB0dXJlZCArIG5vIFBST0pFQ1QubWQgXHUyMTkyIGRpc2N1c3MtcHJvamVjdFwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUlzb2xhdGVkQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IHsgdHJ5IHsgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSBjYXRjaCB7fSB9KTtcblxuICB3cml0ZVByZWZlcmVuY2VzKGJhc2UpO1xuXG4gIGNvbnN0IHByZWZzID0geyBwbGFubmluZ19kZXB0aDogXCJkZWVwXCIgfSBhcyBHU0RQcmVmZXJlbmNlcztcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVzb2x2ZURpc3BhdGNoKG1ha2VDdHgoYmFzZSwgcHJlZnMsIFwibmVlZHMtZGlzY3Vzc2lvblwiKSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuYWN0aW9uLCBcImRpc3BhdGNoXCIpO1xuICBpZiAocmVzdWx0LmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiKSB7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC51bml0VHlwZSwgXCJkaXNjdXNzLXByb2plY3RcIik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiaW50ZWdyYXRpb246IGRlZXAgbW9kZSArIGludmFsaWQgUFJPSkVDVC5tZCBcdTIxOTIgZGlzY3Vzcy1wcm9qZWN0LCBub3QgZGlzY3Vzcy1taWxlc3RvbmVcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiB7IHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2gge30gfSk7XG5cbiAgd3JpdGVQcmVmZXJlbmNlcyhiYXNlKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBST0pFQ1QubWRcIiksIFwiIyBQcm9qZWN0XFxuXCIpO1xuXG4gIGNvbnN0IHByZWZzID0geyBwbGFubmluZ19kZXB0aDogXCJkZWVwXCIgfSBhcyBHU0RQcmVmZXJlbmNlcztcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVzb2x2ZURpc3BhdGNoKG1ha2VDdHgoYmFzZSwgcHJlZnMsIFwibmVlZHMtZGlzY3Vzc2lvblwiKSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuYWN0aW9uLCBcImRpc3BhdGNoXCIpO1xuICBpZiAocmVzdWx0LmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiKSB7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC51bml0VHlwZSwgXCJkaXNjdXNzLXByb2plY3RcIik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiaW50ZWdyYXRpb246IGRlZXAgbW9kZSArIFBST0pFQ1QubWQgKyBubyBSRVFVSVJFTUVOVFMubWQgXHUyMTkyIGRpc2N1c3MtcmVxdWlyZW1lbnRzXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlSXNvbGF0ZWRCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4geyB0cnkgeyBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHt9IH0pO1xuXG4gIHdyaXRlUHJlZmVyZW5jZXMoYmFzZSk7XG4gIHdyaXRlVmFsaWRQcm9qZWN0KGJhc2UpO1xuXG4gIGNvbnN0IHByZWZzID0geyBwbGFubmluZ19kZXB0aDogXCJkZWVwXCIgfSBhcyBHU0RQcmVmZXJlbmNlcztcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVzb2x2ZURpc3BhdGNoKG1ha2VDdHgoYmFzZSwgcHJlZnMsIFwibmVlZHMtZGlzY3Vzc2lvblwiKSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuYWN0aW9uLCBcImRpc3BhdGNoXCIpO1xuICBpZiAocmVzdWx0LmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiKSB7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC51bml0VHlwZSwgXCJkaXNjdXNzLXJlcXVpcmVtZW50c1wiKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJpbnRlZ3JhdGlvbjogZGVlcCBtb2RlICsgaW52YWxpZCBSRVFVSVJFTUVOVFMubWQgXHUyMTkyIGRpc2N1c3MtcmVxdWlyZW1lbnRzLCBub3QgZGlzY3Vzcy1taWxlc3RvbmVcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiB7IHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2gge30gfSk7XG5cbiAgd3JpdGVQcmVmZXJlbmNlcyhiYXNlKTtcbiAgd3JpdGVWYWxpZFByb2plY3QoYmFzZSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJSRVFVSVJFTUVOVFMubWRcIiksIFwiIyBSZXF1aXJlbWVudHNcXG5cIik7XG5cbiAgY29uc3QgcHJlZnMgPSB7IHBsYW5uaW5nX2RlcHRoOiBcImRlZXBcIiB9IGFzIEdTRFByZWZlcmVuY2VzO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXNvbHZlRGlzcGF0Y2gobWFrZUN0eChiYXNlLCBwcmVmcywgXCJuZWVkcy1kaXNjdXNzaW9uXCIpKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5hY3Rpb24sIFwiZGlzcGF0Y2hcIik7XG4gIGlmIChyZXN1bHQuYWN0aW9uID09PSBcImRpc3BhdGNoXCIpIHtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnVuaXRUeXBlLCBcImRpc2N1c3MtcmVxdWlyZW1lbnRzXCIpO1xuICB9XG59KTtcblxudGVzdChcImludGVncmF0aW9uOiBkZWVwIG1vZGUgKyBSRVFVSVJFTUVOVFMubWQgKyBubyByZXNlYXJjaC1kZWNpc2lvbiBcdTIxOTIgZGlzY3Vzcy1taWxlc3RvbmVcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiB7IHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2gge30gfSk7XG5cbiAgd3JpdGVQcmVmZXJlbmNlcyhiYXNlKTtcbiAgd3JpdGVWYWxpZFByb2plY3QoYmFzZSk7XG4gIHdyaXRlVmFsaWRSZXF1aXJlbWVudHMoYmFzZSk7XG5cbiAgY29uc3QgcHJlZnMgPSB7IHBsYW5uaW5nX2RlcHRoOiBcImRlZXBcIiB9IGFzIEdTRFByZWZlcmVuY2VzO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXNvbHZlRGlzcGF0Y2gobWFrZUN0eChiYXNlLCBwcmVmcywgXCJuZWVkcy1kaXNjdXNzaW9uXCIpKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5hY3Rpb24sIFwiZGlzcGF0Y2hcIik7XG4gIGlmIChyZXN1bHQuYWN0aW9uID09PSBcImRpc3BhdGNoXCIpIHtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnVuaXRUeXBlLCBcImRpc2N1c3MtbWlsZXN0b25lXCIpO1xuICB9XG4gIGNvbnN0IGRlY2lzaW9uID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIsIFwicmVzZWFyY2gtZGVjaXNpb24uanNvblwiKSwgXCJ1dGYtOFwiKSk7XG4gIGFzc2VydC5lcXVhbChkZWNpc2lvbi5kZWNpc2lvbiwgXCJza2lwXCIpO1xuICBhc3NlcnQuZXF1YWwoZGVjaXNpb24ucmVhc29uLCBcIm1pc3NpbmctZGVmYXVsdC1yZXBhaXJcIik7XG59KTtcblxudGVzdChcImludGVncmF0aW9uOiBkZWVwIG1vZGUgKyBkZWNpc2lvbj1yZXNlYXJjaCArIHJlc2VhcmNoIGZpbGVzIG1pc3NpbmcgXHUyMTkyIHJlc2VhcmNoLXByb2plY3RcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiB7IHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2gge30gfSk7XG5cbiAgd3JpdGVQcmVmZXJlbmNlcyhiYXNlKTtcbiAgd3JpdGVWYWxpZFByb2plY3QoYmFzZSk7XG4gIHdyaXRlVmFsaWRSZXF1aXJlbWVudHMoYmFzZSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiLCBcInJlc2VhcmNoLWRlY2lzaW9uLmpzb25cIiksXG4gICAgSlNPTi5zdHJpbmdpZnkoeyBkZWNpc2lvbjogXCJyZXNlYXJjaFwiLCBzb3VyY2U6IFwicmVzZWFyY2gtZGVjaXNpb25cIiB9KSxcbiAgKTtcblxuICBjb25zdCBwcmVmcyA9IHsgcGxhbm5pbmdfZGVwdGg6IFwiZGVlcFwiIH0gYXMgR1NEUHJlZmVyZW5jZXM7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlc29sdmVEaXNwYXRjaChtYWtlQ3R4KGJhc2UsIHByZWZzLCBcIm5lZWRzLWRpc2N1c3Npb25cIikpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmFjdGlvbiwgXCJkaXNwYXRjaFwiKTtcbiAgaWYgKHJlc3VsdC5hY3Rpb24gPT09IFwiZGlzcGF0Y2hcIikge1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQudW5pdFR5cGUsIFwicmVzZWFyY2gtcHJvamVjdFwiKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJpbnRlZ3JhdGlvbjogZGVlcCBtb2RlICsgcmVzZWFyY2gtcHJvamVjdCBtYXJrZXIgXHUyMTkyIHN0b3AsIG5vdCBkaXNjdXNzLW1pbGVzdG9uZVwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUlzb2xhdGVkQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IHsgdHJ5IHsgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSBjYXRjaCB7fSB9KTtcblxuICB3cml0ZVByZWZlcmVuY2VzKGJhc2UpO1xuICB3cml0ZVZhbGlkUHJvamVjdChiYXNlKTtcbiAgd3JpdGVWYWxpZFJlcXVpcmVtZW50cyhiYXNlKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIsIFwicmVzZWFyY2gtZGVjaXNpb24uanNvblwiKSxcbiAgICBKU09OLnN0cmluZ2lmeSh7IGRlY2lzaW9uOiBcInJlc2VhcmNoXCIsIHNvdXJjZTogXCJyZXNlYXJjaC1kZWNpc2lvblwiIH0pLFxuICApO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiLCBcInJlc2VhcmNoLXByb2plY3QtaW5mbGlnaHRcIiksIFwie31cXG5cIik7XG5cbiAgY29uc3QgcHJlZnMgPSB7IHBsYW5uaW5nX2RlcHRoOiBcImRlZXBcIiB9IGFzIEdTRFByZWZlcmVuY2VzO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXNvbHZlRGlzcGF0Y2gobWFrZUN0eChiYXNlLCBwcmVmcywgXCJuZWVkcy1kaXNjdXNzaW9uXCIpKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5hY3Rpb24sIFwic3RvcFwiKTtcbiAgaWYgKHJlc3VsdC5hY3Rpb24gPT09IFwic3RvcFwiKSB7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdC5yZWFzb24sIC9yZXNlYXJjaC1wcm9qZWN0LWluZmxpZ2h0Lyk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiaW50ZWdyYXRpb246IGRlZXAgbW9kZSArIGRlY2lzaW9uPXJlc2VhcmNoICsgZGltZW5zaW9uIGJsb2NrZXIgXHUyMTkyIGRpc2N1c3MtbWlsZXN0b25lXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlSXNvbGF0ZWRCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4geyB0cnkgeyBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHt9IH0pO1xuXG4gIHdyaXRlUHJlZmVyZW5jZXMoYmFzZSk7XG4gIHdyaXRlVmFsaWRQcm9qZWN0KGJhc2UpO1xuICB3cml0ZVZhbGlkUmVxdWlyZW1lbnRzKGJhc2UpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiwgXCJyZXNlYXJjaC1kZWNpc2lvbi5qc29uXCIpLFxuICAgIEpTT04uc3RyaW5naWZ5KHsgZGVjaXNpb246IFwicmVzZWFyY2hcIiwgc291cmNlOiBcInJlc2VhcmNoLWRlY2lzaW9uXCIgfSksXG4gICk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJlc2VhcmNoXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIFtcIlNUQUNLLm1kXCIsIFwiRkVBVFVSRVMubWRcIiwgXCJBUkNISVRFQ1RVUkUubWRcIl0pIHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicmVzZWFyY2hcIiwgbmFtZSksIFwiIyBkb25lXFxuXCIpO1xuICB9XG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJyZXNlYXJjaFwiLCBcIlBJVEZBTExTLUJMT0NLRVIubWRcIiksIFwiIyBibG9ja2VyXFxuXCIpO1xuXG4gIGNvbnN0IHByZWZzID0geyBwbGFubmluZ19kZXB0aDogXCJkZWVwXCIgfSBhcyBHU0RQcmVmZXJlbmNlcztcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVzb2x2ZURpc3BhdGNoKG1ha2VDdHgoYmFzZSwgcHJlZnMsIFwibmVlZHMtZGlzY3Vzc2lvblwiKSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuYWN0aW9uLCBcImRpc3BhdGNoXCIpO1xuICBpZiAocmVzdWx0LmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiKSB7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgICAgcmVzdWx0LnVuaXRUeXBlLFxuICAgICAgXCJkaXNjdXNzLW1pbGVzdG9uZVwiLFxuICAgICAgXCJhIGRpbWVuc2lvbiBibG9ja2VyIHNob3VsZCBjbGVhciB0aGUgcHJvamVjdCByZXNlYXJjaCBnYXRlXCIsXG4gICAgKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJpbnRlZ3JhdGlvbjogZGVlcCBtb2RlICsgZGVjaXNpb249c2tpcCBcdTIxOTIgZmFsbHMgdGhyb3VnaCB0byBkaXNjdXNzLW1pbGVzdG9uZSBpbiBuZWVkcy1kaXNjdXNzaW9uXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlSXNvbGF0ZWRCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4geyB0cnkgeyBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHt9IH0pO1xuXG4gIHdyaXRlUHJlZmVyZW5jZXMoYmFzZSk7XG4gIHdyaXRlVmFsaWRQcm9qZWN0KGJhc2UpO1xuICB3cml0ZVZhbGlkUmVxdWlyZW1lbnRzKGJhc2UpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiwgXCJyZXNlYXJjaC1kZWNpc2lvbi5qc29uXCIpLFxuICAgIEpTT04uc3RyaW5naWZ5KHsgZGVjaXNpb246IFwic2tpcFwiIH0pLFxuICApO1xuXG4gIGNvbnN0IHByZWZzID0geyBwbGFubmluZ19kZXB0aDogXCJkZWVwXCIgfSBhcyBHU0RQcmVmZXJlbmNlcztcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVzb2x2ZURpc3BhdGNoKG1ha2VDdHgoYmFzZSwgcHJlZnMsIFwibmVlZHMtZGlzY3Vzc2lvblwiKSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuYWN0aW9uLCBcImRpc3BhdGNoXCIpO1xuICBpZiAocmVzdWx0LmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiKSB7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgICAgcmVzdWx0LnVuaXRUeXBlLFxuICAgICAgXCJkaXNjdXNzLW1pbGVzdG9uZVwiLFxuICAgICAgXCJhZnRlciBhbGwgZGVlcCBzdGFnZSBnYXRlcyBwYXNzIGFuZCB1c2VyIHNraXBwZWQgcmVzZWFyY2gsIG1pbGVzdG9uZSBkaXNjdXNzaW9uIHNob3VsZCBmaXJlXCIsXG4gICAgKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJpbnRlZ3JhdGlvbjogZGVlcCBtb2RlICsgZGVjaXNpb249PGdhcmJhZ2U+IHJlcGFpcnMgdG8gc2tpcCBhbmQgZGlzY3Vzc2VzIG1pbGVzdG9uZVwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUlzb2xhdGVkQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IHsgdHJ5IHsgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSBjYXRjaCB7fSB9KTtcblxuICB3cml0ZVByZWZlcmVuY2VzKGJhc2UpO1xuICB3cml0ZVZhbGlkUHJvamVjdChiYXNlKTtcbiAgd3JpdGVWYWxpZFJlcXVpcmVtZW50cyhiYXNlKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIsIFwicmVzZWFyY2gtZGVjaXNpb24uanNvblwiKSxcbiAgICBKU09OLnN0cmluZ2lmeSh7IGRlY2lzaW9uOiBcImdhcmJhZ2VcIiB9KSxcbiAgKTtcblxuICBjb25zdCBwcmVmcyA9IHsgcGxhbm5pbmdfZGVwdGg6IFwiZGVlcFwiIH0gYXMgR1NEUHJlZmVyZW5jZXM7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlc29sdmVEaXNwYXRjaChtYWtlQ3R4KGJhc2UsIHByZWZzLCBcIm5lZWRzLWRpc2N1c3Npb25cIikpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmFjdGlvbiwgXCJkaXNwYXRjaFwiKTtcbiAgaWYgKHJlc3VsdC5hY3Rpb24gPT09IFwiZGlzcGF0Y2hcIikge1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChcbiAgICAgIHJlc3VsdC51bml0VHlwZSxcbiAgICAgIFwiZGlzY3Vzcy1taWxlc3RvbmVcIixcbiAgICAgIFwibWFsZm9ybWVkIG9yIHVucmVjb2duaXplZCBkZWZhdWx0IHJlc2VhcmNoIG1hcmtlcnMgc2hvdWxkIHJlcGFpciB0byBza2lwIGFuZCBhZHZhbmNlXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBkZWNpc2lvbiA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiLCBcInJlc2VhcmNoLWRlY2lzaW9uLmpzb25cIiksIFwidXRmLThcIikpO1xuICBhc3NlcnQuZXF1YWwoZGVjaXNpb24uZGVjaXNpb24sIFwic2tpcFwiKTtcbiAgYXNzZXJ0LmVxdWFsKGRlY2lzaW9uLnJlYXNvbiwgXCJtYWxmb3JtZWQtZGVmYXVsdC1yZXBhaXJcIik7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIExpZ2h0LW1vZGUgcmVncmVzc2lvbiBjaGVjayBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImludGVncmF0aW9uOiBsaWdodCBtb2RlIChubyBwcmVmcykgKyBuZWVkcy1kaXNjdXNzaW9uIFx1MjE5MiBkaXNjdXNzLW1pbGVzdG9uZSAodW5jaGFuZ2VkIGJlaGF2aW9yKVwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUlzb2xhdGVkQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IHsgdHJ5IHsgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSBjYXRjaCB7fSB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXNvbHZlRGlzcGF0Y2gobWFrZUN0eChiYXNlLCB1bmRlZmluZWQsIFwibmVlZHMtZGlzY3Vzc2lvblwiKSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuYWN0aW9uLCBcImRpc3BhdGNoXCIpO1xuICBpZiAocmVzdWx0LmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiKSB7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC51bml0VHlwZSwgXCJkaXNjdXNzLW1pbGVzdG9uZVwiKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJpbnRlZ3JhdGlvbjogbGlnaHQgbW9kZSArIHBsYW5uaW5nX2RlcHRoPWxpZ2h0ICsgbmVlZHMtZGlzY3Vzc2lvbiBcdTIxOTIgZGlzY3Vzcy1taWxlc3RvbmVcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiB7IHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2gge30gfSk7XG5cbiAgY29uc3QgcHJlZnMgPSB7IHBsYW5uaW5nX2RlcHRoOiBcImxpZ2h0XCIgfSBhcyBHU0RQcmVmZXJlbmNlcztcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVzb2x2ZURpc3BhdGNoKG1ha2VDdHgoYmFzZSwgcHJlZnMsIFwibmVlZHMtZGlzY3Vzc2lvblwiKSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuYWN0aW9uLCBcImRpc3BhdGNoXCIpO1xuICBpZiAocmVzdWx0LmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiKSB7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC51bml0VHlwZSwgXCJkaXNjdXNzLW1pbGVzdG9uZVwiKTtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFTQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsWUFBWSxXQUFXLGNBQWMsUUFBUSxxQkFBcUI7QUFDM0UsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsWUFBWTtBQUNyQixTQUFTLGtCQUFrQjtBQUUzQixTQUFTLHVCQUE2QztBQUl0RCxTQUFTLG1CQUEyQjtBQUNsQyxRQUFNLE9BQU8sS0FBSyxPQUFPLEdBQUcsd0JBQXdCLFdBQVcsQ0FBQyxFQUFFO0FBQ2xFLFlBQVUsS0FBSyxNQUFNLFFBQVEsY0FBYyxNQUFNLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN2RSxTQUFPO0FBQ1Q7QUFFQSxTQUFTLFFBQ1AsVUFDQSxPQUNBLFFBQTJCLG9CQUNWO0FBQ2pCLFFBQU0sUUFBa0I7QUFBQSxJQUN0QjtBQUFBLElBQ0EsaUJBQWlCLEVBQUUsSUFBSSxRQUFRLE9BQU8sT0FBTztBQUFBLElBQzdDLGFBQWE7QUFBQSxJQUNiLFlBQVk7QUFBQSxJQUNaLGlCQUFpQixDQUFDO0FBQUEsSUFDbEIsVUFBVSxDQUFDO0FBQUEsSUFDWCxZQUFZO0FBQUEsSUFDWixVQUFVLENBQUMsRUFBRSxJQUFJLFFBQVEsT0FBTyxRQUFRLFFBQVEsU0FBUyxDQUFDO0FB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
