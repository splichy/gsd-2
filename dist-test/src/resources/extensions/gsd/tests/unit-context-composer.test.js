import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  composeContextModeInstructions,
  composeInlinedContext,
  composeUnitContext,
  manifestBudgetChars
} from "../unit-context-composer.js";
import { KNOWN_UNIT_TYPES, UNIT_MANIFESTS } from "../unit-context-manifest.js";
import {
  buildExecuteTaskPrompt,
  buildGateEvaluatePrompt,
  buildReassessRoadmapPrompt,
  buildWorkflowPreferencesPrompt
} from "../auto-prompts.js";
import { invalidateAllCaches } from "../cache.js";
import {
  openDatabase,
  closeDatabase,
  insertGateRow,
  insertMilestone,
  upsertMilestonePlanning,
  insertSlice
} from "../gsd-db.js";
test("#4782 composer: returns empty string for unknown unit type", async () => {
  const out = await composeInlinedContext("never-dispatched", async () => "body");
  assert.strictEqual(out, "");
});
test("#4782 composer: walks the manifest's inline list in declared order", async () => {
  const calls = [];
  const resolver = async (key) => {
    calls.push(key);
    return `BODY:${key}`;
  };
  const out = await composeInlinedContext("reassess-roadmap", resolver);
  assert.deepEqual(calls, [
    "roadmap",
    "slice-context",
    "slice-summary",
    "project",
    "requirements",
    "decisions"
  ]);
  assert.match(out, /BODY:roadmap\n\n---\n\nBODY:slice-context/);
});
test("#4782 composer: null-returning resolvers are silently omitted", async () => {
  const resolver = async (key) => {
    if (key === "slice-context" || key === "project") return null;
    return `BODY:${key}`;
  };
  const out = await composeInlinedContext("reassess-roadmap", resolver);
  assert.ok(!out.includes("BODY:slice-context"));
  assert.ok(!out.includes("BODY:project"));
  assert.match(out, /BODY:roadmap\n\n---\n\nBODY:slice-summary\n\n---\n\nBODY:requirements\n\n---\n\nBODY:decisions/);
});
test("#4782 composer: empty-string resolvers are omitted (treated as no-op)", async () => {
  const resolver = async (key) => {
    if (key === "slice-context") return "";
    if (key === "slice-summary") return null;
    return `BODY:${key}`;
  };
  const out = await composeInlinedContext("reassess-roadmap", resolver);
  assert.ok(!out.includes("BODY:slice-context"));
  assert.ok(!out.includes("BODY:slice-summary"));
  assert.ok(!out.includes("---\n\n---"));
});
test("#4782 composer: resolver errors surface to caller", async () => {
  const resolver = async () => {
    throw new Error("resolver boom");
  };
  await assert.rejects(
    () => composeInlinedContext("reassess-roadmap", resolver),
    /resolver boom/
  );
});
test("#4782 composer: manifestBudgetChars returns declared budget", () => {
  const small = manifestBudgetChars("reassess-roadmap");
  assert.ok(small !== null && small > 0);
  assert.strictEqual(manifestBudgetChars("never-dispatched"), null);
});
test("Context Mode composer: disabled, unknown, and none modes return empty string", () => {
  assert.strictEqual(
    composeContextModeInstructions("execute-task", { enabled: false, renderMode: "standalone" }),
    ""
  );
  assert.strictEqual(
    composeContextModeInstructions("never-dispatched", { enabled: true, renderMode: "standalone" }),
    ""
  );
  assert.strictEqual(
    composeContextModeInstructions("workflow-preferences", { enabled: true, renderMode: "standalone" }),
    ""
  );
});
test("Context Mode composer: standalone output starts with heading and includes required tools", () => {
  const out = composeContextModeInstructions("execute-task", { enabled: true, renderMode: "standalone" });
  assert.ok(out.startsWith("## Context Mode"));
  assert.match(out, /execution lane/i);
  assert.match(out, /`gsd_exec`/);
  assert.match(out, /builds, tests, and diagnostics/);
  assert.match(out, /`gsd_exec_search`/);
  assert.match(out, /before reruns/);
  assert.match(out, /`gsd_resume`/);
  assert.match(out, /after compaction or resume/);
});
test("Context Mode composer: nested output is compact single sentence", () => {
  const out = composeContextModeInstructions("gate-evaluate", { enabled: true, renderMode: "nested" });
  assert.ok(!out.startsWith("## Context Mode"));
  assert.match(out, /^Context Mode \(verification lane\): /);
  assert.strictEqual(out.split(/\n/).length, 1);
  assert.match(out, /`gsd_exec`/);
  assert.match(out, /`gsd_exec_search`/);
  assert.match(out, /`gsd_resume`/);
  assert.ok(out.length < 240, `nested guidance should stay compact, got ${out.length} chars`);
});
const laneLabelByMode = {
  interview: "interview",
  research: "research",
  planning: "planning",
  execution: "execution",
  verification: "verification",
  orchestration: "orchestration",
  docs: "documentation"
};
test("Context Mode composer: every known eligible unit renders its configured lane and required tools", () => {
  for (const unitType of KNOWN_UNIT_TYPES) {
    const manifest = UNIT_MANIFESTS[unitType];
    assert.ok(manifest, `missing manifest for ${unitType}`);
    const out = composeContextModeInstructions(unitType, { enabled: true, renderMode: "standalone" });
    if (manifest.contextMode === "none") {
      assert.strictEqual(out, "", `${unitType} should not render Context Mode`);
      continue;
    }
    assert.ok(out.startsWith("## Context Mode"), `${unitType} should render standalone Context Mode heading`);
    assert.match(out, new RegExp(`Lane: \\*\\*${laneLabelByMode[manifest.contextMode]} lane\\*\\*\\.`, "i"));
    assert.match(out, /`gsd_exec`/, `${unitType} should mention gsd_exec`);
    assert.match(out, /`gsd_exec_search`/, `${unitType} should mention gsd_exec_search`);
    assert.match(out, /`gsd_resume`/, `${unitType} should mention gsd_resume`);
  }
});
test("Context Mode composer: workflow-preferences and research-decision render no Context Mode block", () => {
  assert.strictEqual(
    composeContextModeInstructions("workflow-preferences", { enabled: true, renderMode: "standalone" }),
    ""
  );
  assert.strictEqual(
    composeContextModeInstructions("research-decision", { enabled: true, renderMode: "standalone" }),
    ""
  );
});
function makeFixtureBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-composer-pilot-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}
function cleanup(base) {
  try {
    closeDatabase();
  } catch {
  }
  invalidateAllCaches();
  rmSync(base, { recursive: true, force: true });
}
function seed(base, mid) {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: mid, title: "Test", status: "active", depends_on: [] });
  upsertMilestonePlanning(mid, {
    title: "Test",
    status: "active",
    vision: "Ship it",
    successCriteria: ["It ships"],
    keyRisks: [],
    proofStrategy: [],
    verificationContract: "",
    verificationIntegration: "",
    verificationOperational: "",
    verificationUat: "",
    definitionOfDone: [],
    requirementCoverage: "",
    boundaryMapMarkdown: ""
  });
  insertSlice({
    id: "S01",
    milestoneId: mid,
    title: "First",
    status: "complete",
    risk: "low",
    depends: [],
    demo: "",
    sequence: 1
  });
}
function writeArtifacts(base) {
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    "# M001\n## Slices\n- [x] **S01: First** `risk:low` `depends:[]`\n"
  );
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md"),
    "---\nid: S01\nparent: M001\n---\n# S01 Summary\n**One-liner**\n\n## What Happened\nDone.\n"
  );
}
test("#4782 phase 2: buildReassessRoadmapPrompt emits composer-shaped context with manifest-declared artifacts", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();
  seed(base, "M001");
  writeArtifacts(base);
  const prompt = await buildReassessRoadmapPrompt("M001", "Test", "S01", base);
  assert.match(prompt, /## Inlined Context \(preloaded — do not re-read these files\)/);
  assert.match(prompt, /### Current Roadmap/);
  assert.match(prompt, /S01: First/);
  assert.match(prompt, /### S01 Summary/);
  assert.match(prompt, /One-liner/);
  assert.ok(!prompt.includes("Slice Context (from discussion)"));
});
test("Context Mode resume injection: eligible prompts include one bounded snapshot block above inlined context", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();
  seed(base, "M001");
  writeArtifacts(base);
  writeFileSync(
    join(base, ".gsd", "last-snapshot.md"),
    "# GSD context snapshot\n\nResume evidence.\n",
    "utf-8"
  );
  const prompt = await buildReassessRoadmapPrompt("M001", "Test", "S01", base);
  assert.equal(prompt.match(/## Context Snapshot/g)?.length, 1);
  assert.match(prompt, /Source: `\.gsd\/last-snapshot\.md`/);
  assert.match(prompt, /Resume evidence/);
  assert.ok(prompt.indexOf("## Context Mode") < prompt.indexOf("## Context Snapshot"));
  assert.ok(prompt.indexOf("## Context Snapshot") < prompt.indexOf("## Inlined Context"));
});
test("Context Mode resume injection: missing snapshot does not add an empty block", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();
  seed(base, "M001");
  writeArtifacts(base);
  const prompt = await buildReassessRoadmapPrompt("M001", "Test", "S01", base);
  assert.match(prompt, /## Context Mode/);
  assert.doesNotMatch(prompt, /## Context Snapshot/);
});
test("Context Mode resume injection: disabled mode suppresses guidance and snapshot reads", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();
  seed(base, "M001");
  writeArtifacts(base);
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\ncontext_mode:\n  enabled: false\n---\n", "utf-8");
  writeFileSync(join(base, ".gsd", "last-snapshot.md"), "# GSD context snapshot\n\nDo not inject.\n", "utf-8");
  const prompt = await buildReassessRoadmapPrompt("M001", "Test", "S01", base);
  assert.doesNotMatch(prompt, /## Context Mode/);
  assert.doesNotMatch(prompt, /## Context Snapshot/);
  assert.doesNotMatch(prompt, /Do not inject/);
});
test("Context Mode resume injection: none-mode units do not inject snapshots", async () => {
  const base = makeFixtureBase();
  try {
    writeFileSync(join(base, ".gsd", "last-snapshot.md"), "# GSD context snapshot\n\nNo lane.\n", "utf-8");
    const prompt = await buildWorkflowPreferencesPrompt(base);
    assert.doesNotMatch(prompt, /## Context Mode/);
    assert.doesNotMatch(prompt, /## Context Snapshot/);
    assert.doesNotMatch(prompt, /No lane/);
  } finally {
    cleanup(base);
  }
});
test("Context Mode prompt suppression: disabled inlined, phase-anchor, and nested prompts omit Context Mode", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();
  seed(base, "M001");
  writeArtifacts(base);
  insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\ncontext_mode:\n  enabled: false\n---\n", "utf-8");
  writeFileSync(join(base, ".gsd", "last-snapshot.md"), "# GSD context snapshot\n\nDo not inject.\n", "utf-8");
  const inlinedPrompt = await buildReassessRoadmapPrompt("M001", "Test", "S01", base);
  assert.doesNotMatch(inlinedPrompt, /## Context Mode|Context Mode \(|## Context Snapshot/);
  const phaseAnchorPrompt = await buildExecuteTaskPrompt("M001", "S01", "First", "T01", "Task", base);
  assert.doesNotMatch(phaseAnchorPrompt, /## Context Mode|Context Mode \(|## Context Snapshot/);
  const nestedPrompt = await buildGateEvaluatePrompt("M001", "Test", "S01", "First", base);
  assert.match(nestedPrompt, /Use this as the prompt for a `subagent` call/);
  assert.doesNotMatch(nestedPrompt, /## Context Mode|Context Mode \(|## Context Snapshot/);
});
const fakeBase = {
  unitType: "reassess-roadmap",
  basePath: process.env.GSD_TEST_WORKSPACE_ROOT ?? process.cwd(),
  milestoneId: "M001",
  sliceId: "S01"
};
test("#4924 v2 composer: returns empty sections for unknown unit type", async () => {
  const out = await composeUnitContext("never-dispatched", { base: fakeBase });
  assert.deepEqual(out, { prepend: "", inline: "" });
});
test("#4924 v2 composer: omitting resolveArtifact skips inline keys without erroring", async () => {
  const out = await composeUnitContext("reassess-roadmap", { base: fakeBase });
  assert.strictEqual(out.inline, "");
  assert.strictEqual(out.prepend, "");
});
test("#4924 v2 composer: walks inline + excerpt + computed sections in declared order", async () => {
  const calls = [];
  const resolveArtifact = async (key) => {
    calls.push(`art:${key}`);
    return `BODY:${key}`;
  };
  const out = await composeUnitContext("run-uat", { base: { ...fakeBase, unitType: "run-uat" }, resolveArtifact });
  assert.deepEqual(calls, ["art:slice-uat", "art:slice-summary", "art:project"]);
  assert.match(out.inline, /BODY:slice-uat\n\n---\n\nBODY:slice-summary\n\n---\n\nBODY:project/);
});
test("#4924 v2 composer: excerpt section calls resolveExcerpt for declared keys", async () => {
  const inlineCalls = [];
  const excerptCalls = [];
  const resolveArtifact = async (key) => {
    inlineCalls.push(key);
    return `INLINE:${key}`;
  };
  const resolveExcerpt = async (key) => {
    excerptCalls.push(key);
    return `EXCERPT:${key}`;
  };
  const out = await composeUnitContext("complete-milestone", {
    base: { ...fakeBase, unitType: "complete-milestone" },
    resolveArtifact,
    resolveExcerpt
  });
  assert.ok(excerptCalls.includes("slice-summary"));
  assert.match(out.inline, /EXCERPT:slice-summary/);
  const cmManifest = UNIT_MANIFESTS["complete-milestone"];
  const firstInlineKey = cmManifest.artifacts.inline[0];
  const firstInlineIdx = out.inline.indexOf(`INLINE:${firstInlineKey}`);
  const excerptIdx = out.inline.indexOf("EXCERPT:slice-summary");
  assert.ok(firstInlineIdx >= 0 && excerptIdx > firstInlineIdx, "inline body should precede excerpt body");
});
test("#4924 v2 composer: prepend block is separate from inline section", async () => {
  const original = UNIT_MANIFESTS["run-uat"];
  const patched = {
    ...original,
    prepend: ["test-banner"]
    // computed id not in production registry — typed via cast for the test
  };
  UNIT_MANIFESTS["run-uat"] = patched;
  try {
    const computed = {
      "test-banner": {
        build: async (_inputs, base) => `BANNER for ${base.unitType}`,
        inputs: void 0
      }
    };
    const out = await composeUnitContext("run-uat", {
      base: { ...fakeBase, unitType: "run-uat" },
      computed
    });
    assert.strictEqual(out.prepend, "BANNER for run-uat");
    assert.strictEqual(out.inline, "");
  } finally {
    UNIT_MANIFESTS["run-uat"] = original;
  }
});
test("#4924 v2 composer: missing computed registry entry is skipped silently", async () => {
  const original = UNIT_MANIFESTS["run-uat"];
  const patched = {
    ...original,
    prepend: ["test-banner"]
  };
  UNIT_MANIFESTS["run-uat"] = patched;
  try {
    const out = await composeUnitContext("run-uat", { base: { ...fakeBase, unitType: "run-uat" } });
    assert.strictEqual(out.prepend, "");
  } finally {
    UNIT_MANIFESTS["run-uat"] = original;
  }
});
test("#4924 v2 composer: computed builder returning null omits the section (no empty separator)", async () => {
  const original = UNIT_MANIFESTS["run-uat"];
  const patched = {
    ...original,
    prepend: ["test-banner-a", "test-banner-b"]
  };
  UNIT_MANIFESTS["run-uat"] = patched;
  try {
    const computed = {
      "test-banner-a": { build: async () => null, inputs: void 0 },
      "test-banner-b": { build: async () => "B", inputs: void 0 }
    };
    const out = await composeUnitContext("run-uat", { base: { ...fakeBase, unitType: "run-uat" }, computed });
    assert.strictEqual(out.prepend, "B");
    assert.ok(!out.prepend.includes("---"));
  } finally {
    UNIT_MANIFESTS["run-uat"] = original;
  }
});
test("#4924 v2 composer: backward-compat \u2014 composeInlinedContext still works for v1 callers", async () => {
  const out = await composeInlinedContext("run-uat", async (key) => `BODY:${key}`);
  assert.match(out, /BODY:slice-uat\n\n---\n\nBODY:slice-summary\n\n---\n\nBODY:project/);
});
test("#4926 review: computed builders see normalized base.unitType matching the resolved manifest", async () => {
  const original = UNIT_MANIFESTS["run-uat"];
  const patched = {
    ...original,
    prepend: ["test-banner"]
  };
  UNIT_MANIFESTS["run-uat"] = patched;
  try {
    let observedUnitType;
    const computed = {
      "test-banner": {
        build: async (_inputs, base) => {
          observedUnitType = base.unitType;
          return `BANNER for ${base.unitType}`;
        },
        inputs: void 0
      }
    };
    const out = await composeUnitContext("run-uat", {
      // Deliberately mismatched: function arg "run-uat" vs. base.unitType "stale-other-unit".
      base: { ...fakeBase, unitType: "stale-other-unit" },
      computed
    });
    assert.strictEqual(observedUnitType, "run-uat", "builder must see the unitType the manifest was resolved against");
    assert.strictEqual(out.prepend, "BANNER for run-uat");
  } finally {
    UNIT_MANIFESTS["run-uat"] = original;
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy91bml0LWNvbnRleHQtY29tcG9zZXIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFRlc3RzIHVuaXQgY29udGV4dCBjb21wb3NlciByZW5kZXJpbmcsIGJ1ZGdldHMsIGFuZCByZWFzc2Vzcy1yb2FkbWFwIHByb21wdCBpbnRlZ3JhdGlvbi5cblxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7XG4gIGNvbXBvc2VDb250ZXh0TW9kZUluc3RydWN0aW9ucyxcbiAgY29tcG9zZUlubGluZWRDb250ZXh0LFxuICBjb21wb3NlVW5pdENvbnRleHQsXG4gIG1hbmlmZXN0QnVkZ2V0Q2hhcnMsXG4gIHR5cGUgQXJ0aWZhY3RSZXNvbHZlcixcbiAgdHlwZSBFeGNlcnB0UmVzb2x2ZXIsXG59IGZyb20gXCIuLi91bml0LWNvbnRleHQtY29tcG9zZXIudHNcIjtcbmltcG9ydCB0eXBlIHtcbiAgQXJ0aWZhY3RLZXksXG4gIEJhc2VSZXNvbHZlckNvbnRleHQsXG4gIENvbXB1dGVkQXJ0aWZhY3RSZWdpc3RyeSxcbiAgVW5pdENvbnRleHRNYW5pZmVzdCxcbn0gZnJvbSBcIi4uL3VuaXQtY29udGV4dC1tYW5pZmVzdC50c1wiO1xuaW1wb3J0IHsgS05PV05fVU5JVF9UWVBFUywgVU5JVF9NQU5JRkVTVFMgfSBmcm9tIFwiLi4vdW5pdC1jb250ZXh0LW1hbmlmZXN0LnRzXCI7XG5pbXBvcnQge1xuICBidWlsZEV4ZWN1dGVUYXNrUHJvbXB0LFxuICBidWlsZEdhdGVFdmFsdWF0ZVByb21wdCxcbiAgYnVpbGRSZWFzc2Vzc1JvYWRtYXBQcm9tcHQsXG4gIGJ1aWxkV29ya2Zsb3dQcmVmZXJlbmNlc1Byb21wdCxcbn0gZnJvbSBcIi4uL2F1dG8tcHJvbXB0cy50c1wiO1xuaW1wb3J0IHsgaW52YWxpZGF0ZUFsbENhY2hlcyB9IGZyb20gXCIuLi9jYWNoZS50c1wiO1xuaW1wb3J0IHtcbiAgb3BlbkRhdGFiYXNlLFxuICBjbG9zZURhdGFiYXNlLFxuICBpbnNlcnRHYXRlUm93LFxuICBpbnNlcnRNaWxlc3RvbmUsXG4gIHVwc2VydE1pbGVzdG9uZVBsYW5uaW5nLFxuICBpbnNlcnRTbGljZSxcbn0gZnJvbSBcIi4uL2dzZC1kYi50c1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUHVyZSBjb21wb3NlciB0ZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcIiM0NzgyIGNvbXBvc2VyOiByZXR1cm5zIGVtcHR5IHN0cmluZyBmb3IgdW5rbm93biB1bml0IHR5cGVcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBvdXQgPSBhd2FpdCBjb21wb3NlSW5saW5lZENvbnRleHQoXCJuZXZlci1kaXNwYXRjaGVkXCIsIGFzeW5jICgpID0+IFwiYm9keVwiKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKG91dCwgXCJcIik7XG59KTtcblxudGVzdChcIiM0NzgyIGNvbXBvc2VyOiB3YWxrcyB0aGUgbWFuaWZlc3QncyBpbmxpbmUgbGlzdCBpbiBkZWNsYXJlZCBvcmRlclwiLCBhc3luYyAoKSA9PiB7XG4gIC8vIHJlYXNzZXNzLXJvYWRtYXAgbWFuaWZlc3Q6IFtyb2FkbWFwLCBzbGljZS1jb250ZXh0LCBzbGljZS1zdW1tYXJ5LCBwcm9qZWN0LCByZXF1aXJlbWVudHMsIGRlY2lzaW9uc11cbiAgY29uc3QgY2FsbHM6IEFydGlmYWN0S2V5W10gPSBbXTtcbiAgY29uc3QgcmVzb2x2ZXI6IEFydGlmYWN0UmVzb2x2ZXIgPSBhc3luYyAoa2V5KSA9PiB7XG4gICAgY2FsbHMucHVzaChrZXkpO1xuICAgIHJldHVybiBgQk9EWToke2tleX1gO1xuICB9O1xuICBjb25zdCBvdXQgPSBhd2FpdCBjb21wb3NlSW5saW5lZENvbnRleHQoXCJyZWFzc2Vzcy1yb2FkbWFwXCIsIHJlc29sdmVyKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChjYWxscywgW1xuICAgIFwicm9hZG1hcFwiLFxuICAgIFwic2xpY2UtY29udGV4dFwiLFxuICAgIFwic2xpY2Utc3VtbWFyeVwiLFxuICAgIFwicHJvamVjdFwiLFxuICAgIFwicmVxdWlyZW1lbnRzXCIsXG4gICAgXCJkZWNpc2lvbnNcIixcbiAgXSk7XG4gIC8vIE91dHB1dCBqb2lucyBibG9ja3Mgd2l0aCB0aGUgXCItLS1cIiBzZXBhcmF0b3IuXG4gIGFzc2VydC5tYXRjaChvdXQsIC9CT0RZOnJvYWRtYXBcXG5cXG4tLS1cXG5cXG5CT0RZOnNsaWNlLWNvbnRleHQvKTtcbn0pO1xuXG50ZXN0KFwiIzQ3ODIgY29tcG9zZXI6IG51bGwtcmV0dXJuaW5nIHJlc29sdmVycyBhcmUgc2lsZW50bHkgb21pdHRlZFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHJlc29sdmVyOiBBcnRpZmFjdFJlc29sdmVyID0gYXN5bmMgKGtleSkgPT4ge1xuICAgIGlmIChrZXkgPT09IFwic2xpY2UtY29udGV4dFwiIHx8IGtleSA9PT0gXCJwcm9qZWN0XCIpIHJldHVybiBudWxsO1xuICAgIHJldHVybiBgQk9EWToke2tleX1gO1xuICB9O1xuICBjb25zdCBvdXQgPSBhd2FpdCBjb21wb3NlSW5saW5lZENvbnRleHQoXCJyZWFzc2Vzcy1yb2FkbWFwXCIsIHJlc29sdmVyKTtcbiAgLy8gc2xpY2UtY29udGV4dCArIHByb2plY3Qgc2tpcHBlZCBcdTIwMTQgbm90IGluIG91dHB1dCwgbm8gZW1wdHkgYmxvY2tzXG4gIGFzc2VydC5vayghb3V0LmluY2x1ZGVzKFwiQk9EWTpzbGljZS1jb250ZXh0XCIpKTtcbiAgYXNzZXJ0Lm9rKCFvdXQuaW5jbHVkZXMoXCJCT0RZOnByb2plY3RcIikpO1xuICAvLyBSZW1haW5pbmcga2V5cyBzdGlsbCBlbWl0dGVkIGluIGRlY2xhcmVkIG9yZGVyXG4gIGFzc2VydC5tYXRjaChvdXQsIC9CT0RZOnJvYWRtYXBcXG5cXG4tLS1cXG5cXG5CT0RZOnNsaWNlLXN1bW1hcnlcXG5cXG4tLS1cXG5cXG5CT0RZOnJlcXVpcmVtZW50c1xcblxcbi0tLVxcblxcbkJPRFk6ZGVjaXNpb25zLyk7XG59KTtcblxudGVzdChcIiM0NzgyIGNvbXBvc2VyOiBlbXB0eS1zdHJpbmcgcmVzb2x2ZXJzIGFyZSBvbWl0dGVkICh0cmVhdGVkIGFzIG5vLW9wKVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHJlc29sdmVyOiBBcnRpZmFjdFJlc29sdmVyID0gYXN5bmMgKGtleSkgPT4ge1xuICAgIGlmIChrZXkgPT09IFwic2xpY2UtY29udGV4dFwiKSByZXR1cm4gXCJcIjtcbiAgICBpZiAoa2V5ID09PSBcInNsaWNlLXN1bW1hcnlcIikgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIGBCT0RZOiR7a2V5fWA7XG4gIH07XG4gIGNvbnN0IG91dCA9IGF3YWl0IGNvbXBvc2VJbmxpbmVkQ29udGV4dChcInJlYXNzZXNzLXJvYWRtYXBcIiwgcmVzb2x2ZXIpO1xuICBhc3NlcnQub2soIW91dC5pbmNsdWRlcyhcIkJPRFk6c2xpY2UtY29udGV4dFwiKSk7XG4gIGFzc2VydC5vayghb3V0LmluY2x1ZGVzKFwiQk9EWTpzbGljZS1zdW1tYXJ5XCIpKTtcbiAgLy8gTXVzdCBub3QgbGVhdmUgZG91YmxlLXNlcGFyYXRvcnMgd2hlbiBibG9ja3MgYXJlIHNraXBwZWRcbiAgYXNzZXJ0Lm9rKCFvdXQuaW5jbHVkZXMoXCItLS1cXG5cXG4tLS1cIikpO1xufSk7XG5cbnRlc3QoXCIjNDc4MiBjb21wb3NlcjogcmVzb2x2ZXIgZXJyb3JzIHN1cmZhY2UgdG8gY2FsbGVyXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgcmVzb2x2ZXI6IEFydGlmYWN0UmVzb2x2ZXIgPSBhc3luYyAoKSA9PiB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwicmVzb2x2ZXIgYm9vbVwiKTtcbiAgfTtcbiAgYXdhaXQgYXNzZXJ0LnJlamVjdHMoXG4gICAgKCkgPT4gY29tcG9zZUlubGluZWRDb250ZXh0KFwicmVhc3Nlc3Mtcm9hZG1hcFwiLCByZXNvbHZlciksXG4gICAgL3Jlc29sdmVyIGJvb20vLFxuICApO1xufSk7XG5cbnRlc3QoXCIjNDc4MiBjb21wb3NlcjogbWFuaWZlc3RCdWRnZXRDaGFycyByZXR1cm5zIGRlY2xhcmVkIGJ1ZGdldFwiLCAoKSA9PiB7XG4gIGNvbnN0IHNtYWxsID0gbWFuaWZlc3RCdWRnZXRDaGFycyhcInJlYXNzZXNzLXJvYWRtYXBcIik7XG4gIGFzc2VydC5vayhzbWFsbCAhPT0gbnVsbCAmJiBzbWFsbCA+IDApO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwobWFuaWZlc3RCdWRnZXRDaGFycyhcIm5ldmVyLWRpc3BhdGNoZWRcIiksIG51bGwpO1xufSk7XG5cbnRlc3QoXCJDb250ZXh0IE1vZGUgY29tcG9zZXI6IGRpc2FibGVkLCB1bmtub3duLCBhbmQgbm9uZSBtb2RlcyByZXR1cm4gZW1wdHkgc3RyaW5nXCIsICgpID0+IHtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgIGNvbXBvc2VDb250ZXh0TW9kZUluc3RydWN0aW9ucyhcImV4ZWN1dGUtdGFza1wiLCB7IGVuYWJsZWQ6IGZhbHNlLCByZW5kZXJNb2RlOiBcInN0YW5kYWxvbmVcIiB9KSxcbiAgICBcIlwiLFxuICApO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoXG4gICAgY29tcG9zZUNvbnRleHRNb2RlSW5zdHJ1Y3Rpb25zKFwibmV2ZXItZGlzcGF0Y2hlZFwiLCB7IGVuYWJsZWQ6IHRydWUsIHJlbmRlck1vZGU6IFwic3RhbmRhbG9uZVwiIH0pLFxuICAgIFwiXCIsXG4gICk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChcbiAgICBjb21wb3NlQ29udGV4dE1vZGVJbnN0cnVjdGlvbnMoXCJ3b3JrZmxvdy1wcmVmZXJlbmNlc1wiLCB7IGVuYWJsZWQ6IHRydWUsIHJlbmRlck1vZGU6IFwic3RhbmRhbG9uZVwiIH0pLFxuICAgIFwiXCIsXG4gICk7XG59KTtcblxudGVzdChcIkNvbnRleHQgTW9kZSBjb21wb3Nlcjogc3RhbmRhbG9uZSBvdXRwdXQgc3RhcnRzIHdpdGggaGVhZGluZyBhbmQgaW5jbHVkZXMgcmVxdWlyZWQgdG9vbHNcIiwgKCkgPT4ge1xuICBjb25zdCBvdXQgPSBjb21wb3NlQ29udGV4dE1vZGVJbnN0cnVjdGlvbnMoXCJleGVjdXRlLXRhc2tcIiwgeyBlbmFibGVkOiB0cnVlLCByZW5kZXJNb2RlOiBcInN0YW5kYWxvbmVcIiB9KTtcbiAgYXNzZXJ0Lm9rKG91dC5zdGFydHNXaXRoKFwiIyMgQ29udGV4dCBNb2RlXCIpKTtcbiAgYXNzZXJ0Lm1hdGNoKG91dCwgL2V4ZWN1dGlvbiBsYW5lL2kpO1xuICBhc3NlcnQubWF0Y2gob3V0LCAvYGdzZF9leGVjYC8pO1xuICBhc3NlcnQubWF0Y2gob3V0LCAvYnVpbGRzLCB0ZXN0cywgYW5kIGRpYWdub3N0aWNzLyk7XG4gIGFzc2VydC5tYXRjaChvdXQsIC9gZ3NkX2V4ZWNfc2VhcmNoYC8pO1xuICBhc3NlcnQubWF0Y2gob3V0LCAvYmVmb3JlIHJlcnVucy8pO1xuICBhc3NlcnQubWF0Y2gob3V0LCAvYGdzZF9yZXN1bWVgLyk7XG4gIGFzc2VydC5tYXRjaChvdXQsIC9hZnRlciBjb21wYWN0aW9uIG9yIHJlc3VtZS8pO1xufSk7XG5cbnRlc3QoXCJDb250ZXh0IE1vZGUgY29tcG9zZXI6IG5lc3RlZCBvdXRwdXQgaXMgY29tcGFjdCBzaW5nbGUgc2VudGVuY2VcIiwgKCkgPT4ge1xuICBjb25zdCBvdXQgPSBjb21wb3NlQ29udGV4dE1vZGVJbnN0cnVjdGlvbnMoXCJnYXRlLWV2YWx1YXRlXCIsIHsgZW5hYmxlZDogdHJ1ZSwgcmVuZGVyTW9kZTogXCJuZXN0ZWRcIiB9KTtcbiAgYXNzZXJ0Lm9rKCFvdXQuc3RhcnRzV2l0aChcIiMjIENvbnRleHQgTW9kZVwiKSk7XG4gIGFzc2VydC5tYXRjaChvdXQsIC9eQ29udGV4dCBNb2RlIFxcKHZlcmlmaWNhdGlvbiBsYW5lXFwpOiAvKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKG91dC5zcGxpdCgvXFxuLykubGVuZ3RoLCAxKTtcbiAgYXNzZXJ0Lm1hdGNoKG91dCwgL2Bnc2RfZXhlY2AvKTtcbiAgYXNzZXJ0Lm1hdGNoKG91dCwgL2Bnc2RfZXhlY19zZWFyY2hgLyk7XG4gIGFzc2VydC5tYXRjaChvdXQsIC9gZ3NkX3Jlc3VtZWAvKTtcbiAgYXNzZXJ0Lm9rKG91dC5sZW5ndGggPCAyNDAsIGBuZXN0ZWQgZ3VpZGFuY2Ugc2hvdWxkIHN0YXkgY29tcGFjdCwgZ290ICR7b3V0Lmxlbmd0aH0gY2hhcnNgKTtcbn0pO1xuXG5jb25zdCBsYW5lTGFiZWxCeU1vZGU6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIGludGVydmlldzogXCJpbnRlcnZpZXdcIixcbiAgcmVzZWFyY2g6IFwicmVzZWFyY2hcIixcbiAgcGxhbm5pbmc6IFwicGxhbm5pbmdcIixcbiAgZXhlY3V0aW9uOiBcImV4ZWN1dGlvblwiLFxuICB2ZXJpZmljYXRpb246IFwidmVyaWZpY2F0aW9uXCIsXG4gIG9yY2hlc3RyYXRpb246IFwib3JjaGVzdHJhdGlvblwiLFxuICBkb2NzOiBcImRvY3VtZW50YXRpb25cIixcbn07XG5cbnRlc3QoXCJDb250ZXh0IE1vZGUgY29tcG9zZXI6IGV2ZXJ5IGtub3duIGVsaWdpYmxlIHVuaXQgcmVuZGVycyBpdHMgY29uZmlndXJlZCBsYW5lIGFuZCByZXF1aXJlZCB0b29sc1wiLCAoKSA9PiB7XG4gIGZvciAoY29uc3QgdW5pdFR5cGUgb2YgS05PV05fVU5JVF9UWVBFUykge1xuICAgIGNvbnN0IG1hbmlmZXN0ID0gVU5JVF9NQU5JRkVTVFNbdW5pdFR5cGVdO1xuICAgIGFzc2VydC5vayhtYW5pZmVzdCwgYG1pc3NpbmcgbWFuaWZlc3QgZm9yICR7dW5pdFR5cGV9YCk7XG4gICAgY29uc3Qgb3V0ID0gY29tcG9zZUNvbnRleHRNb2RlSW5zdHJ1Y3Rpb25zKHVuaXRUeXBlLCB7IGVuYWJsZWQ6IHRydWUsIHJlbmRlck1vZGU6IFwic3RhbmRhbG9uZVwiIH0pO1xuICAgIGlmIChtYW5pZmVzdC5jb250ZXh0TW9kZSA9PT0gXCJub25lXCIpIHtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChvdXQsIFwiXCIsIGAke3VuaXRUeXBlfSBzaG91bGQgbm90IHJlbmRlciBDb250ZXh0IE1vZGVgKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBhc3NlcnQub2sob3V0LnN0YXJ0c1dpdGgoXCIjIyBDb250ZXh0IE1vZGVcIiksIGAke3VuaXRUeXBlfSBzaG91bGQgcmVuZGVyIHN0YW5kYWxvbmUgQ29udGV4dCBNb2RlIGhlYWRpbmdgKTtcbiAgICBhc3NlcnQubWF0Y2gob3V0LCBuZXcgUmVnRXhwKGBMYW5lOiBcXFxcKlxcXFwqJHtsYW5lTGFiZWxCeU1vZGVbbWFuaWZlc3QuY29udGV4dE1vZGVdfSBsYW5lXFxcXCpcXFxcKlxcXFwuYCwgXCJpXCIpKTtcbiAgICBhc3NlcnQubWF0Y2gob3V0LCAvYGdzZF9leGVjYC8sIGAke3VuaXRUeXBlfSBzaG91bGQgbWVudGlvbiBnc2RfZXhlY2ApO1xuICAgIGFzc2VydC5tYXRjaChvdXQsIC9gZ3NkX2V4ZWNfc2VhcmNoYC8sIGAke3VuaXRUeXBlfSBzaG91bGQgbWVudGlvbiBnc2RfZXhlY19zZWFyY2hgKTtcbiAgICBhc3NlcnQubWF0Y2gob3V0LCAvYGdzZF9yZXN1bWVgLywgYCR7dW5pdFR5cGV9IHNob3VsZCBtZW50aW9uIGdzZF9yZXN1bWVgKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJDb250ZXh0IE1vZGUgY29tcG9zZXI6IHdvcmtmbG93LXByZWZlcmVuY2VzIGFuZCByZXNlYXJjaC1kZWNpc2lvbiByZW5kZXIgbm8gQ29udGV4dCBNb2RlIGJsb2NrXCIsICgpID0+IHtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgIGNvbXBvc2VDb250ZXh0TW9kZUluc3RydWN0aW9ucyhcIndvcmtmbG93LXByZWZlcmVuY2VzXCIsIHsgZW5hYmxlZDogdHJ1ZSwgcmVuZGVyTW9kZTogXCJzdGFuZGFsb25lXCIgfSksXG4gICAgXCJcIixcbiAgKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgIGNvbXBvc2VDb250ZXh0TW9kZUluc3RydWN0aW9ucyhcInJlc2VhcmNoLWRlY2lzaW9uXCIsIHsgZW5hYmxlZDogdHJ1ZSwgcmVuZGVyTW9kZTogXCJzdGFuZGFsb25lXCIgfSksXG4gICAgXCJcIixcbiAgKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSW50ZWdyYXRpb246IG1pZ3JhdGVkIGJ1aWxkUmVhc3Nlc3NSb2FkbWFwUHJvbXB0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBtYWtlRml4dHVyZUJhc2UoKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWNvbXBvc2VyLXBpbG90LVwiKSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwidGFza3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gY2xlYW51cChiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHsgY2xvc2VEYXRhYmFzZSgpOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9XG4gIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcbiAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn1cblxuZnVuY3Rpb24gc2VlZChiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nKTogdm9pZCB7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gIGluc2VydE1pbGVzdG9uZSh7IGlkOiBtaWQsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiLCBkZXBlbmRzX29uOiBbXSB9KTtcbiAgdXBzZXJ0TWlsZXN0b25lUGxhbm5pbmcobWlkLCB7XG4gICAgdGl0bGU6IFwiVGVzdFwiLFxuICAgIHN0YXR1czogXCJhY3RpdmVcIixcbiAgICB2aXNpb246IFwiU2hpcCBpdFwiLFxuICAgIHN1Y2Nlc3NDcml0ZXJpYTogW1wiSXQgc2hpcHNcIl0sXG4gICAga2V5Umlza3M6IFtdLFxuICAgIHByb29mU3RyYXRlZ3k6IFtdLFxuICAgIHZlcmlmaWNhdGlvbkNvbnRyYWN0OiBcIlwiLFxuICAgIHZlcmlmaWNhdGlvbkludGVncmF0aW9uOiBcIlwiLFxuICAgIHZlcmlmaWNhdGlvbk9wZXJhdGlvbmFsOiBcIlwiLFxuICAgIHZlcmlmaWNhdGlvblVhdDogXCJcIixcbiAgICBkZWZpbml0aW9uT2ZEb25lOiBbXSxcbiAgICByZXF1aXJlbWVudENvdmVyYWdlOiBcIlwiLFxuICAgIGJvdW5kYXJ5TWFwTWFya2Rvd246IFwiXCIsXG4gIH0pO1xuICBpbnNlcnRTbGljZSh7XG4gICAgaWQ6IFwiUzAxXCIsXG4gICAgbWlsZXN0b25lSWQ6IG1pZCxcbiAgICB0aXRsZTogXCJGaXJzdFwiLFxuICAgIHN0YXR1czogXCJjb21wbGV0ZVwiLFxuICAgIHJpc2s6IFwibG93XCIsXG4gICAgZGVwZW5kczogW10sXG4gICAgZGVtbzogXCJcIixcbiAgICBzZXF1ZW5jZTogMSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlQXJ0aWZhY3RzKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJNMDAxLVJPQURNQVAubWRcIiksXG4gICAgXCIjIE0wMDFcXG4jIyBTbGljZXNcXG4tIFt4XSAqKlMwMTogRmlyc3QqKiBgcmlzazpsb3dgIGBkZXBlbmRzOltdYFxcblwiLFxuICApO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJTMDEtU1VNTUFSWS5tZFwiKSxcbiAgICBcIi0tLVxcbmlkOiBTMDFcXG5wYXJlbnQ6IE0wMDFcXG4tLS1cXG4jIFMwMSBTdW1tYXJ5XFxuKipPbmUtbGluZXIqKlxcblxcbiMjIFdoYXQgSGFwcGVuZWRcXG5Eb25lLlxcblwiLFxuICApO1xufVxuXG50ZXN0KFwiIzQ3ODIgcGhhc2UgMjogYnVpbGRSZWFzc2Vzc1JvYWRtYXBQcm9tcHQgZW1pdHMgY29tcG9zZXItc2hhcGVkIGNvbnRleHQgd2l0aCBtYW5pZmVzdC1kZWNsYXJlZCBhcnRpZmFjdHNcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VGaXh0dXJlQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG5cbiAgc2VlZChiYXNlLCBcIk0wMDFcIik7XG4gIHdyaXRlQXJ0aWZhY3RzKGJhc2UpO1xuXG4gIGNvbnN0IHByb21wdCA9IGF3YWl0IGJ1aWxkUmVhc3Nlc3NSb2FkbWFwUHJvbXB0KFwiTTAwMVwiLCBcIlRlc3RcIiwgXCJTMDFcIiwgYmFzZSk7XG5cbiAgLy8gQ29udGV4dCBibG9jayB3cmFwcGVyIGZyb20gY2FwUHJlYW1ibGVcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgLyMjIElubGluZWQgQ29udGV4dCBcXChwcmVsb2FkZWQgXHUyMDE0IGRvIG5vdCByZS1yZWFkIHRoZXNlIGZpbGVzXFwpLyk7XG5cbiAgLy8gUm9hZG1hcCBpbmxpbmVkIGZpcnN0IChtYW5pZmVzdCBvcmRlcilcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgLyMjIyBDdXJyZW50IFJvYWRtYXAvKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL1MwMTogRmlyc3QvKTtcblxuICAvLyBTbGljZSBzdW1tYXJ5IHByZXNlbnRcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgLyMjIyBTMDEgU3VtbWFyeS8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvT25lLWxpbmVyLyk7XG5cbiAgLy8gU2xpY2UgY29udGV4dCBpcyBvcHRpb25hbCBhbmQgbm90IHByZXNlbnQgaW4gdGhpcyBmaXh0dXJlIFx1MjAxNCBtdXN0IG5vdFxuICAvLyBsZWF2ZSBhIHN0cmF5IGVtcHR5IHNlY3Rpb25cbiAgYXNzZXJ0Lm9rKCFwcm9tcHQuaW5jbHVkZXMoXCJTbGljZSBDb250ZXh0IChmcm9tIGRpc2N1c3Npb24pXCIpKTtcbn0pO1xuXG50ZXN0KFwiQ29udGV4dCBNb2RlIHJlc3VtZSBpbmplY3Rpb246IGVsaWdpYmxlIHByb21wdHMgaW5jbHVkZSBvbmUgYm91bmRlZCBzbmFwc2hvdCBibG9jayBhYm92ZSBpbmxpbmVkIGNvbnRleHRcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VGaXh0dXJlQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG5cbiAgc2VlZChiYXNlLCBcIk0wMDFcIik7XG4gIHdyaXRlQXJ0aWZhY3RzKGJhc2UpO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibGFzdC1zbmFwc2hvdC5tZFwiKSxcbiAgICBcIiMgR1NEIGNvbnRleHQgc25hcHNob3RcXG5cXG5SZXN1bWUgZXZpZGVuY2UuXFxuXCIsXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuXG4gIGNvbnN0IHByb21wdCA9IGF3YWl0IGJ1aWxkUmVhc3Nlc3NSb2FkbWFwUHJvbXB0KFwiTTAwMVwiLCBcIlRlc3RcIiwgXCJTMDFcIiwgYmFzZSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHByb21wdC5tYXRjaCgvIyMgQ29udGV4dCBTbmFwc2hvdC9nKT8ubGVuZ3RoLCAxKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL1NvdXJjZTogYFxcLmdzZFxcL2xhc3Qtc25hcHNob3RcXC5tZGAvKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL1Jlc3VtZSBldmlkZW5jZS8pO1xuICBhc3NlcnQub2socHJvbXB0LmluZGV4T2YoXCIjIyBDb250ZXh0IE1vZGVcIikgPCBwcm9tcHQuaW5kZXhPZihcIiMjIENvbnRleHQgU25hcHNob3RcIikpO1xuICBhc3NlcnQub2socHJvbXB0LmluZGV4T2YoXCIjIyBDb250ZXh0IFNuYXBzaG90XCIpIDwgcHJvbXB0LmluZGV4T2YoXCIjIyBJbmxpbmVkIENvbnRleHRcIikpO1xufSk7XG5cbnRlc3QoXCJDb250ZXh0IE1vZGUgcmVzdW1lIGluamVjdGlvbjogbWlzc2luZyBzbmFwc2hvdCBkb2VzIG5vdCBhZGQgYW4gZW1wdHkgYmxvY2tcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VGaXh0dXJlQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG5cbiAgc2VlZChiYXNlLCBcIk0wMDFcIik7XG4gIHdyaXRlQXJ0aWZhY3RzKGJhc2UpO1xuXG4gIGNvbnN0IHByb21wdCA9IGF3YWl0IGJ1aWxkUmVhc3Nlc3NSb2FkbWFwUHJvbXB0KFwiTTAwMVwiLCBcIlRlc3RcIiwgXCJTMDFcIiwgYmFzZSk7XG5cbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgLyMjIENvbnRleHQgTW9kZS8pO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKHByb21wdCwgLyMjIENvbnRleHQgU25hcHNob3QvKTtcbn0pO1xuXG50ZXN0KFwiQ29udGV4dCBNb2RlIHJlc3VtZSBpbmplY3Rpb246IGRpc2FibGVkIG1vZGUgc3VwcHJlc3NlcyBndWlkYW5jZSBhbmQgc25hcHNob3QgcmVhZHNcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VGaXh0dXJlQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG5cbiAgc2VlZChiYXNlLCBcIk0wMDFcIik7XG4gIHdyaXRlQXJ0aWZhY3RzKGJhc2UpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUFJFRkVSRU5DRVMubWRcIiksIFwiLS0tXFxuY29udGV4dF9tb2RlOlxcbiAgZW5hYmxlZDogZmFsc2VcXG4tLS1cXG5cIiwgXCJ1dGYtOFwiKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcImxhc3Qtc25hcHNob3QubWRcIiksIFwiIyBHU0QgY29udGV4dCBzbmFwc2hvdFxcblxcbkRvIG5vdCBpbmplY3QuXFxuXCIsIFwidXRmLThcIik7XG5cbiAgY29uc3QgcHJvbXB0ID0gYXdhaXQgYnVpbGRSZWFzc2Vzc1JvYWRtYXBQcm9tcHQoXCJNMDAxXCIsIFwiVGVzdFwiLCBcIlMwMVwiLCBiYXNlKTtcblxuICBhc3NlcnQuZG9lc05vdE1hdGNoKHByb21wdCwgLyMjIENvbnRleHQgTW9kZS8pO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKHByb21wdCwgLyMjIENvbnRleHQgU25hcHNob3QvKTtcbiAgYXNzZXJ0LmRvZXNOb3RNYXRjaChwcm9tcHQsIC9EbyBub3QgaW5qZWN0Lyk7XG59KTtcblxudGVzdChcIkNvbnRleHQgTW9kZSByZXN1bWUgaW5qZWN0aW9uOiBub25lLW1vZGUgdW5pdHMgZG8gbm90IGluamVjdCBzbmFwc2hvdHNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUZpeHR1cmVCYXNlKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcImxhc3Qtc25hcHNob3QubWRcIiksIFwiIyBHU0QgY29udGV4dCBzbmFwc2hvdFxcblxcbk5vIGxhbmUuXFxuXCIsIFwidXRmLThcIik7XG4gICAgY29uc3QgcHJvbXB0ID0gYXdhaXQgYnVpbGRXb3JrZmxvd1ByZWZlcmVuY2VzUHJvbXB0KGJhc2UpO1xuICAgIGFzc2VydC5kb2VzTm90TWF0Y2gocHJvbXB0LCAvIyMgQ29udGV4dCBNb2RlLyk7XG4gICAgYXNzZXJ0LmRvZXNOb3RNYXRjaChwcm9tcHQsIC8jIyBDb250ZXh0IFNuYXBzaG90Lyk7XG4gICAgYXNzZXJ0LmRvZXNOb3RNYXRjaChwcm9tcHQsIC9ObyBsYW5lLyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJDb250ZXh0IE1vZGUgcHJvbXB0IHN1cHByZXNzaW9uOiBkaXNhYmxlZCBpbmxpbmVkLCBwaGFzZS1hbmNob3IsIGFuZCBuZXN0ZWQgcHJvbXB0cyBvbWl0IENvbnRleHQgTW9kZVwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUZpeHR1cmVCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChiYXNlKSk7XG4gIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcblxuICBzZWVkKGJhc2UsIFwiTTAwMVwiKTtcbiAgd3JpdGVBcnRpZmFjdHMoYmFzZSk7XG4gIGluc2VydEdhdGVSb3coeyBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIGdhdGVJZDogXCJRM1wiLCBzY29wZTogXCJzbGljZVwiIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUFJFRkVSRU5DRVMubWRcIiksIFwiLS0tXFxuY29udGV4dF9tb2RlOlxcbiAgZW5hYmxlZDogZmFsc2VcXG4tLS1cXG5cIiwgXCJ1dGYtOFwiKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcImxhc3Qtc25hcHNob3QubWRcIiksIFwiIyBHU0QgY29udGV4dCBzbmFwc2hvdFxcblxcbkRvIG5vdCBpbmplY3QuXFxuXCIsIFwidXRmLThcIik7XG5cbiAgY29uc3QgaW5saW5lZFByb21wdCA9IGF3YWl0IGJ1aWxkUmVhc3Nlc3NSb2FkbWFwUHJvbXB0KFwiTTAwMVwiLCBcIlRlc3RcIiwgXCJTMDFcIiwgYmFzZSk7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2goaW5saW5lZFByb21wdCwgLyMjIENvbnRleHQgTW9kZXxDb250ZXh0IE1vZGUgXFwofCMjIENvbnRleHQgU25hcHNob3QvKTtcblxuICBjb25zdCBwaGFzZUFuY2hvclByb21wdCA9IGF3YWl0IGJ1aWxkRXhlY3V0ZVRhc2tQcm9tcHQoXCJNMDAxXCIsIFwiUzAxXCIsIFwiRmlyc3RcIiwgXCJUMDFcIiwgXCJUYXNrXCIsIGJhc2UpO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKHBoYXNlQW5jaG9yUHJvbXB0LCAvIyMgQ29udGV4dCBNb2RlfENvbnRleHQgTW9kZSBcXCh8IyMgQ29udGV4dCBTbmFwc2hvdC8pO1xuXG4gIGNvbnN0IG5lc3RlZFByb21wdCA9IGF3YWl0IGJ1aWxkR2F0ZUV2YWx1YXRlUHJvbXB0KFwiTTAwMVwiLCBcIlRlc3RcIiwgXCJTMDFcIiwgXCJGaXJzdFwiLCBiYXNlKTtcbiAgYXNzZXJ0Lm1hdGNoKG5lc3RlZFByb21wdCwgL1VzZSB0aGlzIGFzIHRoZSBwcm9tcHQgZm9yIGEgYHN1YmFnZW50YCBjYWxsLyk7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2gobmVzdGVkUHJvbXB0LCAvIyMgQ29udGV4dCBNb2RlfENvbnRleHQgTW9kZSBcXCh8IyMgQ29udGV4dCBTbmFwc2hvdC8pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCB2MiBzdXJmYWNlICgjNDkyNCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmNvbnN0IGZha2VCYXNlOiBCYXNlUmVzb2x2ZXJDb250ZXh0ID0ge1xuICB1bml0VHlwZTogXCJyZWFzc2Vzcy1yb2FkbWFwXCIsXG4gIGJhc2VQYXRoOiBwcm9jZXNzLmVudi5HU0RfVEVTVF9XT1JLU1BBQ0VfUk9PVCA/PyBwcm9jZXNzLmN3ZCgpLFxuICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gIHNsaWNlSWQ6IFwiUzAxXCIsXG59O1xuXG50ZXN0KFwiIzQ5MjQgdjIgY29tcG9zZXI6IHJldHVybnMgZW1wdHkgc2VjdGlvbnMgZm9yIHVua25vd24gdW5pdCB0eXBlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgb3V0ID0gYXdhaXQgY29tcG9zZVVuaXRDb250ZXh0KFwibmV2ZXItZGlzcGF0Y2hlZFwiLCB7IGJhc2U6IGZha2VCYXNlIH0pO1xuICBhc3NlcnQuZGVlcEVxdWFsKG91dCwgeyBwcmVwZW5kOiBcIlwiLCBpbmxpbmU6IFwiXCIgfSk7XG59KTtcblxudGVzdChcIiM0OTI0IHYyIGNvbXBvc2VyOiBvbWl0dGluZyByZXNvbHZlQXJ0aWZhY3Qgc2tpcHMgaW5saW5lIGtleXMgd2l0aG91dCBlcnJvcmluZ1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IG91dCA9IGF3YWl0IGNvbXBvc2VVbml0Q29udGV4dChcInJlYXNzZXNzLXJvYWRtYXBcIiwgeyBiYXNlOiBmYWtlQmFzZSB9KTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKG91dC5pbmxpbmUsIFwiXCIpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwob3V0LnByZXBlbmQsIFwiXCIpO1xufSk7XG5cbnRlc3QoXCIjNDkyNCB2MiBjb21wb3Nlcjogd2Fsa3MgaW5saW5lICsgZXhjZXJwdCArIGNvbXB1dGVkIHNlY3Rpb25zIGluIGRlY2xhcmVkIG9yZGVyXCIsIGFzeW5jICgpID0+IHtcbiAgLy8gUmV1c2UgdGhlIHJ1bi11YXQgbWFuaWZlc3Qgc2hhcGUgKHNtYWxsIGlubGluZSwgbm8gZXhjZXJwdC9jb21wdXRlZCkgYW5kXG4gIC8vIHN5bnRoZXNpc2UgYSBtYW5pZmVzdC1zaGFwZSBvdmVycmlkZSB2aWEgYSB0ZW1wb3JhcnkgcmVnaXN0cmF0aW9uIHdvdWxkXG4gIC8vIHJlcXVpcmUgdG91Y2hpbmcgcHJvZHVjdGlvbiBkYXRhLiBJbnN0ZWFkLCBkcml2ZSB0aGUgY29tcG9zZXIgdGhyb3VnaFxuICAvLyB0aGUgZXhpc3RpbmcgbWFuaWZlc3QgcGx1cyBtb2NrIHJlc29sdmVycyBhbmQgdmVyaWZ5IG9yZGVyaW5nIGFnYWluc3RcbiAgLy8gdGhlIGRlY2xhcmVkIHNlcXVlbmNlLlxuICBjb25zdCBjYWxsczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgcmVzb2x2ZUFydGlmYWN0OiBBcnRpZmFjdFJlc29sdmVyID0gYXN5bmMgKGtleSkgPT4ge1xuICAgIGNhbGxzLnB1c2goYGFydDoke2tleX1gKTtcbiAgICByZXR1cm4gYEJPRFk6JHtrZXl9YDtcbiAgfTtcbiAgY29uc3Qgb3V0ID0gYXdhaXQgY29tcG9zZVVuaXRDb250ZXh0KFwicnVuLXVhdFwiLCB7IGJhc2U6IHsgLi4uZmFrZUJhc2UsIHVuaXRUeXBlOiBcInJ1bi11YXRcIiB9LCByZXNvbHZlQXJ0aWZhY3QgfSk7XG4gIC8vIHJ1bi11YXQgbWFuaWZlc3QgaW5saW5lIG9yZGVyOiBzbGljZS11YXQsIHNsaWNlLXN1bW1hcnksIHByb2plY3RcbiAgYXNzZXJ0LmRlZXBFcXVhbChjYWxscywgW1wiYXJ0OnNsaWNlLXVhdFwiLCBcImFydDpzbGljZS1zdW1tYXJ5XCIsIFwiYXJ0OnByb2plY3RcIl0pO1xuICBhc3NlcnQubWF0Y2gob3V0LmlubGluZSwgL0JPRFk6c2xpY2UtdWF0XFxuXFxuLS0tXFxuXFxuQk9EWTpzbGljZS1zdW1tYXJ5XFxuXFxuLS0tXFxuXFxuQk9EWTpwcm9qZWN0Lyk7XG59KTtcblxudGVzdChcIiM0OTI0IHYyIGNvbXBvc2VyOiBleGNlcnB0IHNlY3Rpb24gY2FsbHMgcmVzb2x2ZUV4Y2VycHQgZm9yIGRlY2xhcmVkIGtleXNcIiwgYXN5bmMgKCkgPT4ge1xuICAvLyBjb21wbGV0ZS1taWxlc3RvbmUgZGVjbGFyZXMgc2xpY2Utc3VtbWFyeSBhcyBleGNlcnB0IFx1MjAxNCBwZXJmZWN0IHRhcmdldC5cbiAgY29uc3QgaW5saW5lQ2FsbHM6IEFydGlmYWN0S2V5W10gPSBbXTtcbiAgY29uc3QgZXhjZXJwdENhbGxzOiBBcnRpZmFjdEtleVtdID0gW107XG4gIGNvbnN0IHJlc29sdmVBcnRpZmFjdDogQXJ0aWZhY3RSZXNvbHZlciA9IGFzeW5jIChrZXkpID0+IHtcbiAgICBpbmxpbmVDYWxscy5wdXNoKGtleSk7XG4gICAgcmV0dXJuIGBJTkxJTkU6JHtrZXl9YDtcbiAgfTtcbiAgY29uc3QgcmVzb2x2ZUV4Y2VycHQ6IEV4Y2VycHRSZXNvbHZlciA9IGFzeW5jIChrZXkpID0+IHtcbiAgICBleGNlcnB0Q2FsbHMucHVzaChrZXkpO1xuICAgIHJldHVybiBgRVhDRVJQVDoke2tleX1gO1xuICB9O1xuICBjb25zdCBvdXQgPSBhd2FpdCBjb21wb3NlVW5pdENvbnRleHQoXCJjb21wbGV0ZS1taWxlc3RvbmVcIiwge1xuICAgIGJhc2U6IHsgLi4uZmFrZUJhc2UsIHVuaXRUeXBlOiBcImNvbXBsZXRlLW1pbGVzdG9uZVwiIH0sXG4gICAgcmVzb2x2ZUFydGlmYWN0LFxuICAgIHJlc29sdmVFeGNlcnB0LFxuICB9KTtcbiAgYXNzZXJ0Lm9rKGV4Y2VycHRDYWxscy5pbmNsdWRlcyhcInNsaWNlLXN1bW1hcnlcIikpO1xuICAvLyBFeGNlcnB0IGJvZHkgYXBwZWFycyBpbiB0aGUgY29tcG9zZWQgaW5saW5lIHNlY3Rpb24sIGFmdGVyIGlubGluZSBrZXlzLlxuICBhc3NlcnQubWF0Y2gob3V0LmlubGluZSwgL0VYQ0VSUFQ6c2xpY2Utc3VtbWFyeS8pO1xuICAvLyBUaGUgaW5saW5lIGtleXMgY29tZSBmaXJzdCBwZXIgdGhlIG1hbmlmZXN0IG9yZGVyLlxuICBjb25zdCBjbU1hbmlmZXN0ID0gVU5JVF9NQU5JRkVTVFNbXCJjb21wbGV0ZS1taWxlc3RvbmVcIl07XG4gIGNvbnN0IGZpcnN0SW5saW5lS2V5ID0gY21NYW5pZmVzdC5hcnRpZmFjdHMuaW5saW5lWzBdITtcbiAgY29uc3QgZmlyc3RJbmxpbmVJZHggPSBvdXQuaW5saW5lLmluZGV4T2YoYElOTElORToke2ZpcnN0SW5saW5lS2V5fWApO1xuICBjb25zdCBleGNlcnB0SWR4ID0gb3V0LmlubGluZS5pbmRleE9mKFwiRVhDRVJQVDpzbGljZS1zdW1tYXJ5XCIpO1xuICBhc3NlcnQub2soZmlyc3RJbmxpbmVJZHggPj0gMCAmJiBleGNlcnB0SWR4ID4gZmlyc3RJbmxpbmVJZHgsIFwiaW5saW5lIGJvZHkgc2hvdWxkIHByZWNlZGUgZXhjZXJwdCBib2R5XCIpO1xufSk7XG5cbnRlc3QoXCIjNDkyNCB2MiBjb21wb3NlcjogcHJlcGVuZCBibG9jayBpcyBzZXBhcmF0ZSBmcm9tIGlubGluZSBzZWN0aW9uXCIsIGFzeW5jICgpID0+IHtcbiAgLy8gTm8gcHJvZHVjdGlvbiBtYW5pZmVzdCBkZWNsYXJlcyBhIHByZXBlbmQgYmxvY2sgeWV0ICh0aG9zZSBsYW5kIHdpdGhcbiAgLy8gZWFjaCBiYXRjaGVkIG1pZ3JhdGlvbikuIERyaXZlIHRoZSBjb21wb3NlciB0aHJvdWdoIGEgc3ludGhldGljXG4gIC8vIG1hbmlmZXN0IGJ5IHBhdGNoaW5nIFVOSVRfTUFOSUZFU1RTIGp1c3QgZm9yIHRoaXMgdGVzdC5cbiAgY29uc3Qgb3JpZ2luYWwgPSBVTklUX01BTklGRVNUU1tcInJ1bi11YXRcIl07XG4gIHR5cGUgTXV0YWJsZTxUPiA9IHsgLXJlYWRvbmx5IFtQIGluIGtleW9mIFRdOiBUW1BdIH07XG4gIGNvbnN0IHBhdGNoZWQ6IFVuaXRDb250ZXh0TWFuaWZlc3QgPSB7XG4gICAgLi4ub3JpZ2luYWwsXG4gICAgcHJlcGVuZDogW1widGVzdC1iYW5uZXJcIl0gYXMgbmV2ZXJbXSwgLy8gY29tcHV0ZWQgaWQgbm90IGluIHByb2R1Y3Rpb24gcmVnaXN0cnkgXHUyMDE0IHR5cGVkIHZpYSBjYXN0IGZvciB0aGUgdGVzdFxuICB9O1xuICAoVU5JVF9NQU5JRkVTVFMgYXMgTXV0YWJsZTx0eXBlb2YgVU5JVF9NQU5JRkVTVFM+KVtcInJ1bi11YXRcIl0gPSBwYXRjaGVkO1xuICB0cnkge1xuICAgIGNvbnN0IGNvbXB1dGVkID0ge1xuICAgICAgXCJ0ZXN0LWJhbm5lclwiOiB7XG4gICAgICAgIGJ1aWxkOiBhc3luYyAoX2lucHV0czogbmV2ZXIsIGJhc2U6IEJhc2VSZXNvbHZlckNvbnRleHQpID0+IGBCQU5ORVIgZm9yICR7YmFzZS51bml0VHlwZX1gLFxuICAgICAgICBpbnB1dHM6IHVuZGVmaW5lZCBhcyBuZXZlcixcbiAgICAgIH0sXG4gICAgfSBhcyB1bmtub3duIGFzIENvbXB1dGVkQXJ0aWZhY3RSZWdpc3RyeTtcbiAgICBjb25zdCBvdXQgPSBhd2FpdCBjb21wb3NlVW5pdENvbnRleHQoXCJydW4tdWF0XCIsIHtcbiAgICAgIGJhc2U6IHsgLi4uZmFrZUJhc2UsIHVuaXRUeXBlOiBcInJ1bi11YXRcIiB9LFxuICAgICAgY29tcHV0ZWQsXG4gICAgfSk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKG91dC5wcmVwZW5kLCBcIkJBTk5FUiBmb3IgcnVuLXVhdFwiKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwob3V0LmlubGluZSwgXCJcIik7XG4gIH0gZmluYWxseSB7XG4gICAgKFVOSVRfTUFOSUZFU1RTIGFzIE11dGFibGU8dHlwZW9mIFVOSVRfTUFOSUZFU1RTPilbXCJydW4tdWF0XCJdID0gb3JpZ2luYWw7XG4gIH1cbn0pO1xuXG50ZXN0KFwiIzQ5MjQgdjIgY29tcG9zZXI6IG1pc3NpbmcgY29tcHV0ZWQgcmVnaXN0cnkgZW50cnkgaXMgc2tpcHBlZCBzaWxlbnRseVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IG9yaWdpbmFsID0gVU5JVF9NQU5JRkVTVFNbXCJydW4tdWF0XCJdO1xuICB0eXBlIE11dGFibGU8VD4gPSB7IC1yZWFkb25seSBbUCBpbiBrZXlvZiBUXTogVFtQXSB9O1xuICBjb25zdCBwYXRjaGVkOiBVbml0Q29udGV4dE1hbmlmZXN0ID0ge1xuICAgIC4uLm9yaWdpbmFsLFxuICAgIHByZXBlbmQ6IFtcInRlc3QtYmFubmVyXCJdIGFzIG5ldmVyW10sXG4gIH07XG4gIChVTklUX01BTklGRVNUUyBhcyBNdXRhYmxlPHR5cGVvZiBVTklUX01BTklGRVNUUz4pW1wicnVuLXVhdFwiXSA9IHBhdGNoZWQ7XG4gIHRyeSB7XG4gICAgLy8gTm8gYGNvbXB1dGVkYCByZWdpc3RyeSBzdXBwbGllZCBcdTIwMTQgZGVjbGFyZWQgaWQgc2hvdWxkIGJlIHNraXBwZWQsIG5vdCB0aHJvdy5cbiAgICBjb25zdCBvdXQgPSBhd2FpdCBjb21wb3NlVW5pdENvbnRleHQoXCJydW4tdWF0XCIsIHsgYmFzZTogeyAuLi5mYWtlQmFzZSwgdW5pdFR5cGU6IFwicnVuLXVhdFwiIH0gfSk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKG91dC5wcmVwZW5kLCBcIlwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICAoVU5JVF9NQU5JRkVTVFMgYXMgTXV0YWJsZTx0eXBlb2YgVU5JVF9NQU5JRkVTVFM+KVtcInJ1bi11YXRcIl0gPSBvcmlnaW5hbDtcbiAgfVxufSk7XG5cbnRlc3QoXCIjNDkyNCB2MiBjb21wb3NlcjogY29tcHV0ZWQgYnVpbGRlciByZXR1cm5pbmcgbnVsbCBvbWl0cyB0aGUgc2VjdGlvbiAobm8gZW1wdHkgc2VwYXJhdG9yKVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IG9yaWdpbmFsID0gVU5JVF9NQU5JRkVTVFNbXCJydW4tdWF0XCJdO1xuICB0eXBlIE11dGFibGU8VD4gPSB7IC1yZWFkb25seSBbUCBpbiBrZXlvZiBUXTogVFtQXSB9O1xuICBjb25zdCBwYXRjaGVkOiBVbml0Q29udGV4dE1hbmlmZXN0ID0ge1xuICAgIC4uLm9yaWdpbmFsLFxuICAgIHByZXBlbmQ6IFtcInRlc3QtYmFubmVyLWFcIiwgXCJ0ZXN0LWJhbm5lci1iXCJdIGFzIG5ldmVyW10sXG4gIH07XG4gIChVTklUX01BTklGRVNUUyBhcyBNdXRhYmxlPHR5cGVvZiBVTklUX01BTklGRVNUUz4pW1wicnVuLXVhdFwiXSA9IHBhdGNoZWQ7XG4gIHRyeSB7XG4gICAgY29uc3QgY29tcHV0ZWQgPSB7XG4gICAgICBcInRlc3QtYmFubmVyLWFcIjogeyBidWlsZDogYXN5bmMgKCkgPT4gbnVsbCwgaW5wdXRzOiB1bmRlZmluZWQgYXMgbmV2ZXIgfSxcbiAgICAgIFwidGVzdC1iYW5uZXItYlwiOiB7IGJ1aWxkOiBhc3luYyAoKSA9PiBcIkJcIiwgaW5wdXRzOiB1bmRlZmluZWQgYXMgbmV2ZXIgfSxcbiAgICB9IGFzIHVua25vd24gYXMgQ29tcHV0ZWRBcnRpZmFjdFJlZ2lzdHJ5O1xuICAgIGNvbnN0IG91dCA9IGF3YWl0IGNvbXBvc2VVbml0Q29udGV4dChcInJ1bi11YXRcIiwgeyBiYXNlOiB7IC4uLmZha2VCYXNlLCB1bml0VHlwZTogXCJydW4tdWF0XCIgfSwgY29tcHV0ZWQgfSk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKG91dC5wcmVwZW5kLCBcIkJcIik7XG4gICAgYXNzZXJ0Lm9rKCFvdXQucHJlcGVuZC5pbmNsdWRlcyhcIi0tLVwiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgKFVOSVRfTUFOSUZFU1RTIGFzIE11dGFibGU8dHlwZW9mIFVOSVRfTUFOSUZFU1RTPilbXCJydW4tdWF0XCJdID0gb3JpZ2luYWw7XG4gIH1cbn0pO1xuXG50ZXN0KFwiIzQ5MjQgdjIgY29tcG9zZXI6IGJhY2t3YXJkLWNvbXBhdCBcdTIwMTQgY29tcG9zZUlubGluZWRDb250ZXh0IHN0aWxsIHdvcmtzIGZvciB2MSBjYWxsZXJzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgb3V0ID0gYXdhaXQgY29tcG9zZUlubGluZWRDb250ZXh0KFwicnVuLXVhdFwiLCBhc3luYyAoa2V5KSA9PiBgQk9EWToke2tleX1gKTtcbiAgYXNzZXJ0Lm1hdGNoKG91dCwgL0JPRFk6c2xpY2UtdWF0XFxuXFxuLS0tXFxuXFxuQk9EWTpzbGljZS1zdW1tYXJ5XFxuXFxuLS0tXFxuXFxuQk9EWTpwcm9qZWN0Lyk7XG59KTtcblxudGVzdChcIiM0OTI2IHJldmlldzogY29tcHV0ZWQgYnVpbGRlcnMgc2VlIG5vcm1hbGl6ZWQgYmFzZS51bml0VHlwZSBtYXRjaGluZyB0aGUgcmVzb2x2ZWQgbWFuaWZlc3RcIiwgYXN5bmMgKCkgPT4ge1xuICAvLyBDYWxsZXIgcGFzc2VzIG9uZSB1bml0VHlwZSB0byBjb21wb3NlVW5pdENvbnRleHQgYnV0IGEgZGlmZmVyZW50IChzdGFsZSlcbiAgLy8gdmFsdWUgaW4gb3B0cy5iYXNlLiBDb21wb3NlciBtdXN0IG5vcm1hbGl6ZSBzbyBidWlsZGVycyBvYnNlcnZlIHRoZVxuICAvLyB1bml0VHlwZSB0aGUgbWFuaWZlc3Qgd2FzIHJlc29sdmVkIGFnYWluc3QgXHUyMDE0IHByZXZlbnRpbmcgbWFuaWZlc3RzIGFuZFxuICAvLyBjb21wdXRlZCBjb250ZXh0IGZyb20gZHJpZnRpbmcuXG4gIGNvbnN0IG9yaWdpbmFsID0gVU5JVF9NQU5JRkVTVFNbXCJydW4tdWF0XCJdO1xuICB0eXBlIE11dGFibGU8VD4gPSB7IC1yZWFkb25seSBbUCBpbiBrZXlvZiBUXTogVFtQXSB9O1xuICBjb25zdCBwYXRjaGVkOiBVbml0Q29udGV4dE1hbmlmZXN0ID0ge1xuICAgIC4uLm9yaWdpbmFsLFxuICAgIHByZXBlbmQ6IFtcInRlc3QtYmFubmVyXCJdIGFzIG5ldmVyW10sXG4gIH07XG4gIChVTklUX01BTklGRVNUUyBhcyBNdXRhYmxlPHR5cGVvZiBVTklUX01BTklGRVNUUz4pW1wicnVuLXVhdFwiXSA9IHBhdGNoZWQ7XG4gIHRyeSB7XG4gICAgbGV0IG9ic2VydmVkVW5pdFR5cGU6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBjb25zdCBjb21wdXRlZCA9IHtcbiAgICAgIFwidGVzdC1iYW5uZXJcIjoge1xuICAgICAgICBidWlsZDogYXN5bmMgKF9pbnB1dHM6IG5ldmVyLCBiYXNlOiBCYXNlUmVzb2x2ZXJDb250ZXh0KSA9PiB7XG4gICAgICAgICAgb2JzZXJ2ZWRVbml0VHlwZSA9IGJhc2UudW5pdFR5cGU7XG4gICAgICAgICAgcmV0dXJuIGBCQU5ORVIgZm9yICR7YmFzZS51bml0VHlwZX1gO1xuICAgICAgICB9LFxuICAgICAgICBpbnB1dHM6IHVuZGVmaW5lZCBhcyBuZXZlcixcbiAgICAgIH0sXG4gICAgfSBhcyB1bmtub3duIGFzIENvbXB1dGVkQXJ0aWZhY3RSZWdpc3RyeTtcbiAgICBjb25zdCBvdXQgPSBhd2FpdCBjb21wb3NlVW5pdENvbnRleHQoXCJydW4tdWF0XCIsIHtcbiAgICAgIC8vIERlbGliZXJhdGVseSBtaXNtYXRjaGVkOiBmdW5jdGlvbiBhcmcgXCJydW4tdWF0XCIgdnMuIGJhc2UudW5pdFR5cGUgXCJzdGFsZS1vdGhlci11bml0XCIuXG4gICAgICBiYXNlOiB7IC4uLmZha2VCYXNlLCB1bml0VHlwZTogXCJzdGFsZS1vdGhlci11bml0XCIgfSxcbiAgICAgIGNvbXB1dGVkLFxuICAgIH0pO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChvYnNlcnZlZFVuaXRUeXBlLCBcInJ1bi11YXRcIiwgXCJidWlsZGVyIG11c3Qgc2VlIHRoZSB1bml0VHlwZSB0aGUgbWFuaWZlc3Qgd2FzIHJlc29sdmVkIGFnYWluc3RcIik7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKG91dC5wcmVwZW5kLCBcIkJBTk5FUiBmb3IgcnVuLXVhdFwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICAoVU5JVF9NQU5JRkVTVFMgYXMgTXV0YWJsZTx0eXBlb2YgVU5JVF9NQU5JRkVTVFM+KVtcInJ1bi11YXRcIl0gPSBvcmlnaW5hbDtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFHQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEscUJBQXFCO0FBQzlELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FHSztBQU9QLFNBQVMsa0JBQWtCLHNCQUFzQjtBQUNqRDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUywyQkFBMkI7QUFDcEM7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBSVAsS0FBSyw4REFBOEQsWUFBWTtBQUM3RSxRQUFNLE1BQU0sTUFBTSxzQkFBc0Isb0JBQW9CLFlBQVksTUFBTTtBQUM5RSxTQUFPLFlBQVksS0FBSyxFQUFFO0FBQzVCLENBQUM7QUFFRCxLQUFLLHNFQUFzRSxZQUFZO0FBRXJGLFFBQU0sUUFBdUIsQ0FBQztBQUM5QixRQUFNLFdBQTZCLE9BQU8sUUFB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
