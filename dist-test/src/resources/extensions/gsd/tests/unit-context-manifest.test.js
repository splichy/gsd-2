import test from "node:test";
import assert from "node:assert/strict";
import {
  ARTIFACT_KEYS,
  KNOWN_UNIT_TYPES,
  UNIT_MANIFESTS,
  resolveSubagentPermissionContract,
  resolveManifest
} from "../unit-context-manifest.js";
import {
  ALLOWED_PLANNING_DISPATCH_AGENTS,
  shouldBlockPlanningUnit
} from "../bootstrap/write-gate.js";
import {
  getRequiredWorkflowToolsForAutoUnit,
  getRequiredWorkflowToolsForGuidedUnit
} from "../workflow-mcp.js";
test("#4782 phase 1: every KNOWN_UNIT_TYPES entry has a UNIT_MANIFESTS entry", () => {
  for (const unitType of KNOWN_UNIT_TYPES) {
    assert.ok(
      UNIT_MANIFESTS[unitType],
      `unit type "${unitType}" is declared in KNOWN_UNIT_TYPES but has no manifest`
    );
  }
});
test("#4782 phase 1: every UNIT_MANIFESTS entry corresponds to a known unit type", () => {
  const known = new Set(KNOWN_UNIT_TYPES);
  for (const unitType of Object.keys(UNIT_MANIFESTS)) {
    assert.ok(
      known.has(unitType),
      `manifest entry "${unitType}" is not in KNOWN_UNIT_TYPES \u2014 add it there or remove the manifest`
    );
  }
});
test("#4782 phase 1: workflow tool policy maps are defined for every known unit type", () => {
  for (const unitType of KNOWN_UNIT_TYPES) {
    assert.ok(Array.isArray(getRequiredWorkflowToolsForAutoUnit(unitType)));
    assert.ok(Array.isArray(getRequiredWorkflowToolsForGuidedUnit(unitType)));
  }
});
test("#4782 phase 1: every manifest's artifacts reference known ArtifactKey values", () => {
  const validKeys = new Set(ARTIFACT_KEYS);
  for (const [unitType, manifest] of Object.entries(UNIT_MANIFESTS)) {
    const all = [
      ...manifest.artifacts.inline,
      ...manifest.artifacts.excerpt,
      ...manifest.artifacts.onDemand
    ];
    for (const key of all) {
      assert.ok(
        validKeys.has(key),
        `manifest "${unitType}" references unknown artifact key "${key}"`
      );
    }
  }
});
test("#4782 phase 1: no manifest has the same artifact key in inline AND excerpt (mutually exclusive)", () => {
  for (const [unitType, manifest] of Object.entries(UNIT_MANIFESTS)) {
    const inline = new Set(manifest.artifacts.inline);
    const clashes = manifest.artifacts.excerpt.filter((k) => inline.has(k));
    assert.deepEqual(
      clashes,
      [],
      `manifest "${unitType}" has overlapping inline+excerpt artifact keys: ${clashes.join(", ")}. Pick one.`
    );
  }
});
test("#4782 phase 1: every manifest has a positive maxSystemPromptChars", () => {
  for (const [unitType, manifest] of Object.entries(UNIT_MANIFESTS)) {
    assert.ok(
      typeof manifest.maxSystemPromptChars === "number" && manifest.maxSystemPromptChars > 0,
      `manifest "${unitType}" has invalid maxSystemPromptChars: ${manifest.maxSystemPromptChars}`
    );
  }
});
test("Context Mode: every manifest declares the expected contextMode lane", () => {
  const expected = {
    "workflow-preferences": "none",
    "research-decision": "none",
    "discuss-project": "interview",
    "discuss-requirements": "interview",
    "discuss-milestone": "interview",
    "research-project": "research",
    "research-milestone": "research",
    "research-slice": "research",
    "plan-milestone": "planning",
    "plan-slice": "planning",
    "refine-slice": "planning",
    "replan-slice": "planning",
    "reassess-roadmap": "planning",
    "execute-task": "execution",
    "reactive-execute": "execution",
    "run-uat": "verification",
    "gate-evaluate": "verification",
    "validate-milestone": "verification",
    "complete-slice": "verification",
    "complete-milestone": "verification",
    "rewrite-docs": "docs"
  };
  assert.deepEqual(Object.keys(expected).sort(), [...KNOWN_UNIT_TYPES].sort());
  for (const unitType of KNOWN_UNIT_TYPES) {
    assert.strictEqual(UNIT_MANIFESTS[unitType].contextMode, expected[unitType]);
  }
});
test("#4782 phase 1: skills policy shapes are valid discriminated-union members", () => {
  for (const [unitType, manifest] of Object.entries(UNIT_MANIFESTS)) {
    const p = manifest.skills;
    switch (p.mode) {
      case "none":
      case "all":
        break;
      case "allowlist":
        assert.ok(
          Array.isArray(p.skills) && p.skills.every((s) => typeof s === "string"),
          `manifest "${unitType}" has allowlist policy with invalid skills[]`
        );
        break;
      default: {
        const _exhaustive = p;
        void _exhaustive;
        assert.fail(`manifest "${unitType}" has unrecognized skills.mode`);
      }
    }
  }
});
test("#4782 phase 1: resolveManifest returns null for an unknown unit type", () => {
  assert.strictEqual(resolveManifest("never-dispatched-unit-type"), null);
});
test("#4782 phase 1: resolveManifest returns a manifest for every known unit type", () => {
  for (const unitType of KNOWN_UNIT_TYPES) {
    const m = resolveManifest(unitType);
    assert.ok(m, `resolveManifest("${unitType}") should return a manifest`);
    assert.strictEqual(m, UNIT_MANIFESTS[unitType]);
  }
});
test("#4782 phase 1: complete-milestone manifest declares slice-summary as excerpt (matches #4780)", () => {
  const m = UNIT_MANIFESTS["complete-milestone"];
  assert.ok(
    m.artifacts.excerpt.includes("slice-summary"),
    "complete-milestone should declare slice-summary as excerpt (alignment with #4780)"
  );
  assert.ok(
    !m.artifacts.inline.includes("slice-summary"),
    "complete-milestone should NOT declare slice-summary as inline \u2014 that was the #4780 bloat"
  );
});
test("#4924: computed + prepend ids (when declared) are non-empty strings", () => {
  for (const [unitType, manifest] of Object.entries(UNIT_MANIFESTS)) {
    const ids = [
      ...manifest.artifacts.computed ?? [],
      ...manifest.prepend ?? []
    ];
    for (const id of ids) {
      assert.ok(
        typeof id === "string" && id.length > 0,
        `manifest "${unitType}" has an empty/invalid computed/prepend id: ${JSON.stringify(id)}`
      );
    }
  }
});
test("#4924: no computed id appears in both artifacts.computed AND prepend (mutually exclusive position)", () => {
  for (const [unitType, manifest] of Object.entries(UNIT_MANIFESTS)) {
    const inlineComputed = new Set(
      manifest.artifacts.computed ?? []
    );
    const clashes = (manifest.prepend ?? []).filter((id) => inlineComputed.has(id));
    assert.deepEqual(
      clashes,
      [],
      `manifest "${unitType}" places computed id(s) in both prepend and inline-computed: ${clashes.join(", ")}. Pick one position.`
    );
  }
});
test("#4934: every manifest declares a tools policy", () => {
  for (const [unitType, manifest] of Object.entries(UNIT_MANIFESTS)) {
    const policy = manifest.tools;
    assert.ok(
      policy && typeof policy.mode === "string",
      `manifest "${unitType}" is missing a tools policy \u2014 required to fail loud rather than default to "all" silently`
    );
  }
});
test("#4934: tools.mode is one of the declared policies", () => {
  const validModes = /* @__PURE__ */ new Set(["all", "read-only", "planning", "planning-dispatch", "docs", "verification"]);
  for (const [unitType, manifest] of Object.entries(UNIT_MANIFESTS)) {
    const mode = manifest.tools.mode;
    assert.ok(
      validModes.has(mode),
      `manifest "${unitType}" has invalid tools.mode "${mode}" \u2014 must be one of ${[...validModes].join(", ")}`
    );
  }
});
test('#4934: only execution units and complete-milestone may use tools.mode "all"', () => {
  const allowedAllUnits = /* @__PURE__ */ new Set(["execute-task", "reactive-execute", "complete-milestone"]);
  for (const [unitType, manifest] of Object.entries(UNIT_MANIFESTS)) {
    const mode = manifest.tools.mode;
    if (mode === "all") {
      assert.ok(
        allowedAllUnits.has(unitType),
        `manifest "${unitType}" declares tools.mode = "all" but is not explicitly allowed. Only execute-task, reactive-execute, and complete-milestone should have full source write access; planning/discuss/research units must use "planning" or "planning-dispatch" (or "docs" for rewrite-docs).`
      );
    }
  }
});
test("#5453: complete-milestone uses all tools so bash verification is not planning-dispatch blocked", () => {
  const manifest = UNIT_MANIFESTS["complete-milestone"];
  assert.strictEqual(manifest.tools.mode, "all");
  assert.deepEqual(resolveSubagentPermissionContract("complete-milestone"), {
    allowed: true,
    allowedSubagents: ["*"],
    toolsMode: "all"
  });
  for (const cmd of ["git diff --name-only HEAD~1", "git log -n1 --oneline"]) {
    const result = shouldBlockPlanningUnit(
      "bash",
      cmd,
      process.cwd(),
      "complete-milestone",
      manifest.tools
    );
    assert.strictEqual(
      result.block,
      false,
      `shouldBlockPlanningUnit must not block ${cmd} for complete-milestone: ${result.reason}`
    );
  }
});
test("#5843: run-uat uses verification tools policy so build/test commands can run", () => {
  const manifest = UNIT_MANIFESTS["run-uat"];
  assert.strictEqual(manifest.tools.mode, "verification");
  const buildResult = shouldBlockPlanningUnit(
    "bash",
    "npm run build 2>&1",
    process.cwd(),
    "run-uat",
    manifest.tools
  );
  assert.strictEqual(
    buildResult.block,
    false,
    `run-uat must allow build verification commands: ${buildResult.reason}`
  );
  const sourceWriteResult = shouldBlockPlanningUnit(
    "edit",
    "src/main.ts",
    process.cwd(),
    "run-uat",
    manifest.tools
  );
  assert.strictEqual(sourceWriteResult.block, true);
  assert.match(sourceWriteResult.reason, /tools-policy "verification"/);
});
test("planning-dispatch mode is reserved for slice-level decomposition and completion units", () => {
  const allowedDispatchUnits = /* @__PURE__ */ new Set([
    "plan-slice",
    "research-slice",
    "refine-slice",
    "complete-slice",
    "gate-evaluate",
    // Deep planning mode: research-project orchestrates 4 parallel research
    // subagents (stack/features/architecture/pitfalls). Subagent dispatch is
    // the unit's core mechanism — without it, the unit cannot do its job.
    "research-project",
    "validate-milestone"
  ]);
  for (const [unitType, manifest] of Object.entries(UNIT_MANIFESTS)) {
    const mode = manifest.tools.mode;
    if (mode === "planning-dispatch") {
      assert.ok(
        allowedDispatchUnits.has(unitType),
        `manifest "${unitType}" declares tools.mode = "planning-dispatch" but is not on the dispatch-allowed allowlist. planning-dispatch is intentionally narrow \u2014 extend the allowlist consciously when a new unit type genuinely benefits from subagent delegation.`
      );
    }
  }
});
test("Unit Tool Contract exposes subagent dispatch permissions", () => {
  assert.deepEqual(resolveSubagentPermissionContract("plan-slice"), {
    allowed: true,
    allowedSubagents: ["scout", "planner"],
    toolsMode: "planning-dispatch"
  });
  assert.deepEqual(resolveSubagentPermissionContract("gate-evaluate"), {
    allowed: true,
    allowedSubagents: ["reviewer", "security", "tester"],
    toolsMode: "planning-dispatch"
  });
  assert.deepEqual(resolveSubagentPermissionContract("discuss-milestone"), {
    allowed: false,
    allowedSubagents: [],
    toolsMode: "planning"
  });
});
test("planning-dispatch manifests declare non-empty allowedSubagents lists", () => {
  for (const [unitType, manifest] of Object.entries(UNIT_MANIFESTS)) {
    if (manifest.tools.mode !== "planning-dispatch") continue;
    assert.ok(
      Array.isArray(manifest.tools.allowedSubagents) && manifest.tools.allowedSubagents.length > 0,
      `manifest "${unitType}" has planning-dispatch policy but no allowedSubagents \u2014 explicit allowlist is required for runtime dispatch gating`
    );
    for (const agent of manifest.tools.allowedSubagents) {
      assert.ok(
        typeof agent === "string" && agent.length > 0,
        `manifest "${unitType}" has empty/invalid allowedSubagents entry: ${JSON.stringify(agent)}`
      );
      assert.ok(
        ALLOWED_PLANNING_DISPATCH_AGENTS.has(agent),
        `manifest "${unitType}" allows "${agent}", but the runtime planning-dispatch registry will hard-block it`
      );
    }
  }
});
test('#4934: tools.mode "docs" requires a non-empty allowedPathGlobs array', () => {
  for (const [unitType, manifest] of Object.entries(UNIT_MANIFESTS)) {
    const tools = manifest.tools;
    if (tools.mode !== "docs") continue;
    assert.ok(
      Array.isArray(tools.allowedPathGlobs) && tools.allowedPathGlobs.length > 0,
      `manifest "${unitType}" has docs policy but no allowedPathGlobs \u2014 explicit allow-set is required so the enforcement layer doesn't fall back to a hardcoded default`
    );
    for (const g of tools.allowedPathGlobs) {
      assert.ok(
        typeof g === "string" && g.length > 0,
        `manifest "${unitType}" has empty/invalid allowedPathGlobs entry: ${JSON.stringify(g)}`
      );
    }
  }
});
test("#4782 phase 2: run-uat and gate-evaluate use the smallest budget tier", () => {
  const uatBudget = UNIT_MANIFESTS["run-uat"].maxSystemPromptChars;
  const gateBudget = UNIT_MANIFESTS["gate-evaluate"].maxSystemPromptChars;
  assert.strictEqual(uatBudget, gateBudget, "run-uat and gate-evaluate both use COMMON_BUDGET_SMALL");
  for (const [unitType, other] of Object.entries(UNIT_MANIFESTS)) {
    assert.ok(
      uatBudget <= other.maxSystemPromptChars,
      `run-uat budget (${uatBudget}) should be \u2264 ${unitType} budget (${other.maxSystemPromptChars})`
    );
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy91bml0LWNvbnRleHQtbWFuaWZlc3QudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NELTIgXHUyMDE0ICM0NzgyIHBoYXNlIDE6IHNjaGVtYSB0ZXN0cyArIENJIGNvdmVyYWdlIGd1YXJkIGZvciBtYW5pZmVzdHMuXG5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuXG5pbXBvcnQge1xuICBBUlRJRkFDVF9LRVlTLFxuICBLTk9XTl9VTklUX1RZUEVTLFxuICBVTklUX01BTklGRVNUUyxcbiAgcmVzb2x2ZVN1YmFnZW50UGVybWlzc2lvbkNvbnRyYWN0LFxuICByZXNvbHZlTWFuaWZlc3QsXG4gIHR5cGUgQXJ0aWZhY3RLZXksXG4gIHR5cGUgQ29udGV4dE1vZGVQb2xpY3ksXG4gIHR5cGUgU2tpbGxzUG9saWN5LFxuICB0eXBlIFVuaXRDb250ZXh0TWFuaWZlc3QsXG59IGZyb20gXCIuLi91bml0LWNvbnRleHQtbWFuaWZlc3QudHNcIjtcbmltcG9ydCB7XG4gIEFMTE9XRURfUExBTk5JTkdfRElTUEFUQ0hfQUdFTlRTLFxuICBzaG91bGRCbG9ja1BsYW5uaW5nVW5pdCxcbn0gZnJvbSBcIi4uL2Jvb3RzdHJhcC93cml0ZS1nYXRlLnRzXCI7XG5pbXBvcnQge1xuICBnZXRSZXF1aXJlZFdvcmtmbG93VG9vbHNGb3JBdXRvVW5pdCxcbiAgZ2V0UmVxdWlyZWRXb3JrZmxvd1Rvb2xzRm9yR3VpZGVkVW5pdCxcbn0gZnJvbSBcIi4uL3dvcmtmbG93LW1jcC50c1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ292ZXJhZ2U6IGV2ZXJ5IGtub3duIHVuaXQgdHlwZSBoYXMgYSBtYW5pZmVzdCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcIiM0NzgyIHBoYXNlIDE6IGV2ZXJ5IEtOT1dOX1VOSVRfVFlQRVMgZW50cnkgaGFzIGEgVU5JVF9NQU5JRkVTVFMgZW50cnlcIiwgKCkgPT4ge1xuICBmb3IgKGNvbnN0IHVuaXRUeXBlIG9mIEtOT1dOX1VOSVRfVFlQRVMpIHtcbiAgICBhc3NlcnQub2soXG4gICAgICBVTklUX01BTklGRVNUU1t1bml0VHlwZV0sXG4gICAgICBgdW5pdCB0eXBlIFwiJHt1bml0VHlwZX1cIiBpcyBkZWNsYXJlZCBpbiBLTk9XTl9VTklUX1RZUEVTIGJ1dCBoYXMgbm8gbWFuaWZlc3RgLFxuICAgICk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiIzQ3ODIgcGhhc2UgMTogZXZlcnkgVU5JVF9NQU5JRkVTVFMgZW50cnkgY29ycmVzcG9uZHMgdG8gYSBrbm93biB1bml0IHR5cGVcIiwgKCkgPT4ge1xuICBjb25zdCBrbm93biA9IG5ldyBTZXQ8c3RyaW5nPihLTk9XTl9VTklUX1RZUEVTIGFzIHJlYWRvbmx5IHN0cmluZ1tdKTtcbiAgZm9yIChjb25zdCB1bml0VHlwZSBvZiBPYmplY3Qua2V5cyhVTklUX01BTklGRVNUUykpIHtcbiAgICBhc3NlcnQub2soXG4gICAgICBrbm93bi5oYXModW5pdFR5cGUpLFxuICAgICAgYG1hbmlmZXN0IGVudHJ5IFwiJHt1bml0VHlwZX1cIiBpcyBub3QgaW4gS05PV05fVU5JVF9UWVBFUyBcdTIwMTQgYWRkIGl0IHRoZXJlIG9yIHJlbW92ZSB0aGUgbWFuaWZlc3RgLFxuICAgICk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ292ZXJhZ2U6IGV2ZXJ5IHVuaXRUeXBlIHN0cmluZ2x5LXR5cGVkIGluIGF1dG8tZGlzcGF0Y2gudHMgaXMga25vd24gXHUyNTAwXG5cbnRlc3QoXCIjNDc4MiBwaGFzZSAxOiB3b3JrZmxvdyB0b29sIHBvbGljeSBtYXBzIGFyZSBkZWZpbmVkIGZvciBldmVyeSBrbm93biB1bml0IHR5cGVcIiwgKCkgPT4ge1xuICBmb3IgKGNvbnN0IHVuaXRUeXBlIG9mIEtOT1dOX1VOSVRfVFlQRVMpIHtcbiAgICBhc3NlcnQub2soQXJyYXkuaXNBcnJheShnZXRSZXF1aXJlZFdvcmtmbG93VG9vbHNGb3JBdXRvVW5pdCh1bml0VHlwZSkpKTtcbiAgICBhc3NlcnQub2soQXJyYXkuaXNBcnJheShnZXRSZXF1aXJlZFdvcmtmbG93VG9vbHNGb3JHdWlkZWRVbml0KHVuaXRUeXBlKSkpO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNoYXBlOiBldmVyeSBtYW5pZmVzdCBjb25mb3JtcyB0byB0aGUgc2NoZW1hIGludmFyaWFudHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCIjNDc4MiBwaGFzZSAxOiBldmVyeSBtYW5pZmVzdCdzIGFydGlmYWN0cyByZWZlcmVuY2Uga25vd24gQXJ0aWZhY3RLZXkgdmFsdWVzXCIsICgpID0+IHtcbiAgY29uc3QgdmFsaWRLZXlzID0gbmV3IFNldDxzdHJpbmc+KEFSVElGQUNUX0tFWVMgYXMgcmVhZG9ubHkgc3RyaW5nW10pO1xuICBmb3IgKGNvbnN0IFt1bml0VHlwZSwgbWFuaWZlc3RdIG9mIE9iamVjdC5lbnRyaWVzKFVOSVRfTUFOSUZFU1RTKSkge1xuICAgIGNvbnN0IGFsbDogQXJ0aWZhY3RLZXlbXSA9IFtcbiAgICAgIC4uLm1hbmlmZXN0LmFydGlmYWN0cy5pbmxpbmUsXG4gICAgICAuLi5tYW5pZmVzdC5hcnRpZmFjdHMuZXhjZXJwdCxcbiAgICAgIC4uLm1hbmlmZXN0LmFydGlmYWN0cy5vbkRlbWFuZCxcbiAgICBdO1xuICAgIGZvciAoY29uc3Qga2V5IG9mIGFsbCkge1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICB2YWxpZEtleXMuaGFzKGtleSksXG4gICAgICAgIGBtYW5pZmVzdCBcIiR7dW5pdFR5cGV9XCIgcmVmZXJlbmNlcyB1bmtub3duIGFydGlmYWN0IGtleSBcIiR7a2V5fVwiYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG59KTtcblxudGVzdChcIiM0NzgyIHBoYXNlIDE6IG5vIG1hbmlmZXN0IGhhcyB0aGUgc2FtZSBhcnRpZmFjdCBrZXkgaW4gaW5saW5lIEFORCBleGNlcnB0IChtdXR1YWxseSBleGNsdXNpdmUpXCIsICgpID0+IHtcbiAgZm9yIChjb25zdCBbdW5pdFR5cGUsIG1hbmlmZXN0XSBvZiBPYmplY3QuZW50cmllcyhVTklUX01BTklGRVNUUykpIHtcbiAgICBjb25zdCBpbmxpbmUgPSBuZXcgU2V0PHN0cmluZz4obWFuaWZlc3QuYXJ0aWZhY3RzLmlubGluZSBhcyByZWFkb25seSBzdHJpbmdbXSk7XG4gICAgY29uc3QgY2xhc2hlcyA9IChtYW5pZmVzdC5hcnRpZmFjdHMuZXhjZXJwdCBhcyByZWFkb25seSBzdHJpbmdbXSkuZmlsdGVyKGsgPT4gaW5saW5lLmhhcyhrKSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICAgIGNsYXNoZXMsXG4gICAgICBbXSxcbiAgICAgIGBtYW5pZmVzdCBcIiR7dW5pdFR5cGV9XCIgaGFzIG92ZXJsYXBwaW5nIGlubGluZStleGNlcnB0IGFydGlmYWN0IGtleXM6ICR7Y2xhc2hlcy5qb2luKFwiLCBcIil9LiBQaWNrIG9uZS5gLFxuICAgICk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiIzQ3ODIgcGhhc2UgMTogZXZlcnkgbWFuaWZlc3QgaGFzIGEgcG9zaXRpdmUgbWF4U3lzdGVtUHJvbXB0Q2hhcnNcIiwgKCkgPT4ge1xuICBmb3IgKGNvbnN0IFt1bml0VHlwZSwgbWFuaWZlc3RdIG9mIE9iamVjdC5lbnRyaWVzKFVOSVRfTUFOSUZFU1RTKSkge1xuICAgIGFzc2VydC5vayhcbiAgICAgIHR5cGVvZiBtYW5pZmVzdC5tYXhTeXN0ZW1Qcm9tcHRDaGFycyA9PT0gXCJudW1iZXJcIiAmJiBtYW5pZmVzdC5tYXhTeXN0ZW1Qcm9tcHRDaGFycyA+IDAsXG4gICAgICBgbWFuaWZlc3QgXCIke3VuaXRUeXBlfVwiIGhhcyBpbnZhbGlkIG1heFN5c3RlbVByb21wdENoYXJzOiAke21hbmlmZXN0Lm1heFN5c3RlbVByb21wdENoYXJzfWAsXG4gICAgKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJDb250ZXh0IE1vZGU6IGV2ZXJ5IG1hbmlmZXN0IGRlY2xhcmVzIHRoZSBleHBlY3RlZCBjb250ZXh0TW9kZSBsYW5lXCIsICgpID0+IHtcbiAgY29uc3QgZXhwZWN0ZWQ6IFJlY29yZDxzdHJpbmcsIENvbnRleHRNb2RlUG9saWN5PiA9IHtcbiAgICBcIndvcmtmbG93LXByZWZlcmVuY2VzXCI6IFwibm9uZVwiLFxuICAgIFwicmVzZWFyY2gtZGVjaXNpb25cIjogXCJub25lXCIsXG4gICAgXCJkaXNjdXNzLXByb2plY3RcIjogXCJpbnRlcnZpZXdcIixcbiAgICBcImRpc2N1c3MtcmVxdWlyZW1lbnRzXCI6IFwiaW50ZXJ2aWV3XCIsXG4gICAgXCJkaXNjdXNzLW1pbGVzdG9uZVwiOiBcImludGVydmlld1wiLFxuICAgIFwicmVzZWFyY2gtcHJvamVjdFwiOiBcInJlc2VhcmNoXCIsXG4gICAgXCJyZXNlYXJjaC1taWxlc3RvbmVcIjogXCJyZXNlYXJjaFwiLFxuICAgIFwicmVzZWFyY2gtc2xpY2VcIjogXCJyZXNlYXJjaFwiLFxuICAgIFwicGxhbi1taWxlc3RvbmVcIjogXCJwbGFubmluZ1wiLFxuICAgIFwicGxhbi1zbGljZVwiOiBcInBsYW5uaW5nXCIsXG4gICAgXCJyZWZpbmUtc2xpY2VcIjogXCJwbGFubmluZ1wiLFxuICAgIFwicmVwbGFuLXNsaWNlXCI6IFwicGxhbm5pbmdcIixcbiAgICBcInJlYXNzZXNzLXJvYWRtYXBcIjogXCJwbGFubmluZ1wiLFxuICAgIFwiZXhlY3V0ZS10YXNrXCI6IFwiZXhlY3V0aW9uXCIsXG4gICAgXCJyZWFjdGl2ZS1leGVjdXRlXCI6IFwiZXhlY3V0aW9uXCIsXG4gICAgXCJydW4tdWF0XCI6IFwidmVyaWZpY2F0aW9uXCIsXG4gICAgXCJnYXRlLWV2YWx1YXRlXCI6IFwidmVyaWZpY2F0aW9uXCIsXG4gICAgXCJ2YWxpZGF0ZS1taWxlc3RvbmVcIjogXCJ2ZXJpZmljYXRpb25cIixcbiAgICBcImNvbXBsZXRlLXNsaWNlXCI6IFwidmVyaWZpY2F0aW9uXCIsXG4gICAgXCJjb21wbGV0ZS1taWxlc3RvbmVcIjogXCJ2ZXJpZmljYXRpb25cIixcbiAgICBcInJld3JpdGUtZG9jc1wiOiBcImRvY3NcIixcbiAgfTtcblxuICBhc3NlcnQuZGVlcEVxdWFsKE9iamVjdC5rZXlzKGV4cGVjdGVkKS5zb3J0KCksIFsuLi5LTk9XTl9VTklUX1RZUEVTXS5zb3J0KCkpO1xuICBmb3IgKGNvbnN0IHVuaXRUeXBlIG9mIEtOT1dOX1VOSVRfVFlQRVMpIHtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoVU5JVF9NQU5JRkVTVFNbdW5pdFR5cGVdLmNvbnRleHRNb2RlLCBleHBlY3RlZFt1bml0VHlwZV0pO1xuICB9XG59KTtcblxudGVzdChcIiM0NzgyIHBoYXNlIDE6IHNraWxscyBwb2xpY3kgc2hhcGVzIGFyZSB2YWxpZCBkaXNjcmltaW5hdGVkLXVuaW9uIG1lbWJlcnNcIiwgKCkgPT4ge1xuICBmb3IgKGNvbnN0IFt1bml0VHlwZSwgbWFuaWZlc3RdIG9mIE9iamVjdC5lbnRyaWVzKFVOSVRfTUFOSUZFU1RTKSkge1xuICAgIGNvbnN0IHAgPSBtYW5pZmVzdC5za2lsbHMgYXMgU2tpbGxzUG9saWN5O1xuICAgIHN3aXRjaCAocC5tb2RlKSB7XG4gICAgICBjYXNlIFwibm9uZVwiOlxuICAgICAgY2FzZSBcImFsbFwiOlxuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJhbGxvd2xpc3RcIjpcbiAgICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICAgIEFycmF5LmlzQXJyYXkocC5za2lsbHMpICYmIHAuc2tpbGxzLmV2ZXJ5KHMgPT4gdHlwZW9mIHMgPT09IFwic3RyaW5nXCIpLFxuICAgICAgICAgIGBtYW5pZmVzdCBcIiR7dW5pdFR5cGV9XCIgaGFzIGFsbG93bGlzdCBwb2xpY3kgd2l0aCBpbnZhbGlkIHNraWxsc1tdYCxcbiAgICAgICAgKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBkZWZhdWx0OiB7XG4gICAgICAgIGNvbnN0IF9leGhhdXN0aXZlOiBuZXZlciA9IHA7XG4gICAgICAgIHZvaWQgX2V4aGF1c3RpdmU7XG4gICAgICAgIGFzc2VydC5mYWlsKGBtYW5pZmVzdCBcIiR7dW5pdFR5cGV9XCIgaGFzIHVucmVjb2duaXplZCBza2lsbHMubW9kZWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBMb29rdXAgaGVscGVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiIzQ3ODIgcGhhc2UgMTogcmVzb2x2ZU1hbmlmZXN0IHJldHVybnMgbnVsbCBmb3IgYW4gdW5rbm93biB1bml0IHR5cGVcIiwgKCkgPT4ge1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzb2x2ZU1hbmlmZXN0KFwibmV2ZXItZGlzcGF0Y2hlZC11bml0LXR5cGVcIiksIG51bGwpO1xufSk7XG5cbnRlc3QoXCIjNDc4MiBwaGFzZSAxOiByZXNvbHZlTWFuaWZlc3QgcmV0dXJucyBhIG1hbmlmZXN0IGZvciBldmVyeSBrbm93biB1bml0IHR5cGVcIiwgKCkgPT4ge1xuICBmb3IgKGNvbnN0IHVuaXRUeXBlIG9mIEtOT1dOX1VOSVRfVFlQRVMpIHtcbiAgICBjb25zdCBtID0gcmVzb2x2ZU1hbmlmZXN0KHVuaXRUeXBlKTtcbiAgICBhc3NlcnQub2sobSwgYHJlc29sdmVNYW5pZmVzdChcIiR7dW5pdFR5cGV9XCIpIHNob3VsZCByZXR1cm4gYSBtYW5pZmVzdGApO1xuICAgIC8vIElkZW50aXR5IGNoZWNrIFx1MjAxNCB0aGUgaGVscGVyIHNob3VsZCByZXR1cm4gdGhlIGV4YWN0IG9iamVjdCwgbm90IGEgY29weS5cbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwobSwgVU5JVF9NQU5JRkVTVFNbdW5pdFR5cGVdKTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQaGFzZS0yIHRhcmdldDogY29tcGxldGUtbWlsZXN0b25lIG1hbmlmZXN0IHJlZmxlY3RzICM0NzgwJ3MgZXhjZXJwdCBzaGFwZSBcdTI1MDBcblxudGVzdChcIiM0NzgyIHBoYXNlIDE6IGNvbXBsZXRlLW1pbGVzdG9uZSBtYW5pZmVzdCBkZWNsYXJlcyBzbGljZS1zdW1tYXJ5IGFzIGV4Y2VycHQgKG1hdGNoZXMgIzQ3ODApXCIsICgpID0+IHtcbiAgY29uc3QgbSA9IFVOSVRfTUFOSUZFU1RTW1wiY29tcGxldGUtbWlsZXN0b25lXCJdO1xuICBhc3NlcnQub2soXG4gICAgbS5hcnRpZmFjdHMuZXhjZXJwdC5pbmNsdWRlcyhcInNsaWNlLXN1bW1hcnlcIiksXG4gICAgXCJjb21wbGV0ZS1taWxlc3RvbmUgc2hvdWxkIGRlY2xhcmUgc2xpY2Utc3VtbWFyeSBhcyBleGNlcnB0IChhbGlnbm1lbnQgd2l0aCAjNDc4MClcIixcbiAgKTtcbiAgYXNzZXJ0Lm9rKFxuICAgICFtLmFydGlmYWN0cy5pbmxpbmUuaW5jbHVkZXMoXCJzbGljZS1zdW1tYXJ5XCIpLFxuICAgIFwiY29tcGxldGUtbWlsZXN0b25lIHNob3VsZCBOT1QgZGVjbGFyZSBzbGljZS1zdW1tYXJ5IGFzIGlubGluZSBcdTIwMTQgdGhhdCB3YXMgdGhlICM0NzgwIGJsb2F0XCIsXG4gICk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHYyIGNvbnRyYWN0IGludmFyaWFudHMgKCM0OTI0KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcIiM0OTI0OiBjb21wdXRlZCArIHByZXBlbmQgaWRzICh3aGVuIGRlY2xhcmVkKSBhcmUgbm9uLWVtcHR5IHN0cmluZ3NcIiwgKCkgPT4ge1xuICBmb3IgKGNvbnN0IFt1bml0VHlwZSwgbWFuaWZlc3RdIG9mIE9iamVjdC5lbnRyaWVzKFVOSVRfTUFOSUZFU1RTKSkge1xuICAgIGNvbnN0IGlkczogc3RyaW5nW10gPSBbXG4gICAgICAuLi4oKG1hbmlmZXN0LmFydGlmYWN0cyBhcyB7IGNvbXB1dGVkPzogcmVhZG9ubHkgc3RyaW5nW10gfSkuY29tcHV0ZWQgPz8gW10pLFxuICAgICAgLi4uKChtYW5pZmVzdCBhcyB7IHByZXBlbmQ/OiByZWFkb25seSBzdHJpbmdbXSB9KS5wcmVwZW5kID8/IFtdKSxcbiAgICBdO1xuICAgIGZvciAoY29uc3QgaWQgb2YgaWRzKSB7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIHR5cGVvZiBpZCA9PT0gXCJzdHJpbmdcIiAmJiBpZC5sZW5ndGggPiAwLFxuICAgICAgICBgbWFuaWZlc3QgXCIke3VuaXRUeXBlfVwiIGhhcyBhbiBlbXB0eS9pbnZhbGlkIGNvbXB1dGVkL3ByZXBlbmQgaWQ6ICR7SlNPTi5zdHJpbmdpZnkoaWQpfWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxufSk7XG5cbnRlc3QoXCIjNDkyNDogbm8gY29tcHV0ZWQgaWQgYXBwZWFycyBpbiBib3RoIGFydGlmYWN0cy5jb21wdXRlZCBBTkQgcHJlcGVuZCAobXV0dWFsbHkgZXhjbHVzaXZlIHBvc2l0aW9uKVwiLCAoKSA9PiB7XG4gIGZvciAoY29uc3QgW3VuaXRUeXBlLCBtYW5pZmVzdF0gb2YgT2JqZWN0LmVudHJpZXMoVU5JVF9NQU5JRkVTVFMpKSB7XG4gICAgY29uc3QgaW5saW5lQ29tcHV0ZWQgPSBuZXcgU2V0PHN0cmluZz4oXG4gICAgICAoKG1hbmlmZXN0LmFydGlmYWN0cyBhcyB7IGNvbXB1dGVkPzogcmVhZG9ubHkgc3RyaW5nW10gfSkuY29tcHV0ZWQgPz8gW10pLFxuICAgICk7XG4gICAgY29uc3QgY2xhc2hlcyA9ICgobWFuaWZlc3QgYXMgeyBwcmVwZW5kPzogcmVhZG9ubHkgc3RyaW5nW10gfSkucHJlcGVuZCA/PyBbXSlcbiAgICAgIC5maWx0ZXIoaWQgPT4gaW5saW5lQ29tcHV0ZWQuaGFzKGlkKSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICAgIGNsYXNoZXMsXG4gICAgICBbXSxcbiAgICAgIGBtYW5pZmVzdCBcIiR7dW5pdFR5cGV9XCIgcGxhY2VzIGNvbXB1dGVkIGlkKHMpIGluIGJvdGggcHJlcGVuZCBhbmQgaW5saW5lLWNvbXB1dGVkOiAke2NsYXNoZXMuam9pbihcIiwgXCIpfS4gUGljayBvbmUgcG9zaXRpb24uYCxcbiAgICApO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRvb2xzLXBvbGljeSBpbnZhcmlhbnRzICgjNDkzNCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCIjNDkzNDogZXZlcnkgbWFuaWZlc3QgZGVjbGFyZXMgYSB0b29scyBwb2xpY3lcIiwgKCkgPT4ge1xuICBmb3IgKGNvbnN0IFt1bml0VHlwZSwgbWFuaWZlc3RdIG9mIE9iamVjdC5lbnRyaWVzKFVOSVRfTUFOSUZFU1RTKSkge1xuICAgIGNvbnN0IHBvbGljeSA9IChtYW5pZmVzdCBhcyB7IHRvb2xzPzogeyBtb2RlPzogc3RyaW5nIH0gfSkudG9vbHM7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgcG9saWN5ICYmIHR5cGVvZiBwb2xpY3kubW9kZSA9PT0gXCJzdHJpbmdcIixcbiAgICAgIGBtYW5pZmVzdCBcIiR7dW5pdFR5cGV9XCIgaXMgbWlzc2luZyBhIHRvb2xzIHBvbGljeSBcdTIwMTQgcmVxdWlyZWQgdG8gZmFpbCBsb3VkIHJhdGhlciB0aGFuIGRlZmF1bHQgdG8gXCJhbGxcIiBzaWxlbnRseWAsXG4gICAgKTtcbiAgfVxufSk7XG5cbnRlc3QoXCIjNDkzNDogdG9vbHMubW9kZSBpcyBvbmUgb2YgdGhlIGRlY2xhcmVkIHBvbGljaWVzXCIsICgpID0+IHtcbiAgY29uc3QgdmFsaWRNb2RlcyA9IG5ldyBTZXQoW1wiYWxsXCIsIFwicmVhZC1vbmx5XCIsIFwicGxhbm5pbmdcIiwgXCJwbGFubmluZy1kaXNwYXRjaFwiLCBcImRvY3NcIiwgXCJ2ZXJpZmljYXRpb25cIl0pO1xuICBmb3IgKGNvbnN0IFt1bml0VHlwZSwgbWFuaWZlc3RdIG9mIE9iamVjdC5lbnRyaWVzKFVOSVRfTUFOSUZFU1RTKSkge1xuICAgIGNvbnN0IG1vZGUgPSAobWFuaWZlc3QgYXMgeyB0b29sczogeyBtb2RlOiBzdHJpbmcgfSB9KS50b29scy5tb2RlO1xuICAgIGFzc2VydC5vayhcbiAgICAgIHZhbGlkTW9kZXMuaGFzKG1vZGUpLFxuICAgICAgYG1hbmlmZXN0IFwiJHt1bml0VHlwZX1cIiBoYXMgaW52YWxpZCB0b29scy5tb2RlIFwiJHttb2RlfVwiIFx1MjAxNCBtdXN0IGJlIG9uZSBvZiAke1suLi52YWxpZE1vZGVzXS5qb2luKFwiLCBcIil9YCxcbiAgICApO1xuICB9XG59KTtcblxudGVzdCgnIzQ5MzQ6IG9ubHkgZXhlY3V0aW9uIHVuaXRzIGFuZCBjb21wbGV0ZS1taWxlc3RvbmUgbWF5IHVzZSB0b29scy5tb2RlIFwiYWxsXCInLCAoKSA9PiB7XG4gIGNvbnN0IGFsbG93ZWRBbGxVbml0cyA9IG5ldyBTZXQoW1wiZXhlY3V0ZS10YXNrXCIsIFwicmVhY3RpdmUtZXhlY3V0ZVwiLCBcImNvbXBsZXRlLW1pbGVzdG9uZVwiXSk7XG4gIGZvciAoY29uc3QgW3VuaXRUeXBlLCBtYW5pZmVzdF0gb2YgT2JqZWN0LmVudHJpZXMoVU5JVF9NQU5JRkVTVFMpKSB7XG4gICAgY29uc3QgbW9kZSA9IChtYW5pZmVzdCBhcyB7IHRvb2xzOiB7IG1vZGU6IHN0cmluZyB9IH0pLnRvb2xzLm1vZGU7XG4gICAgaWYgKG1vZGUgPT09IFwiYWxsXCIpIHtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgYWxsb3dlZEFsbFVuaXRzLmhhcyh1bml0VHlwZSksXG4gICAgICAgIGBtYW5pZmVzdCBcIiR7dW5pdFR5cGV9XCIgZGVjbGFyZXMgdG9vbHMubW9kZSA9IFwiYWxsXCIgYnV0IGlzIG5vdCBleHBsaWNpdGx5IGFsbG93ZWQuIGAgK1xuICAgICAgICAnT25seSBleGVjdXRlLXRhc2ssIHJlYWN0aXZlLWV4ZWN1dGUsIGFuZCBjb21wbGV0ZS1taWxlc3RvbmUgc2hvdWxkIGhhdmUgZnVsbCBzb3VyY2Ugd3JpdGUgYWNjZXNzOyAnICtcbiAgICAgICAgJ3BsYW5uaW5nL2Rpc2N1c3MvcmVzZWFyY2ggdW5pdHMgbXVzdCB1c2UgXCJwbGFubmluZ1wiIG9yIFwicGxhbm5pbmctZGlzcGF0Y2hcIiAob3IgXCJkb2NzXCIgZm9yIHJld3JpdGUtZG9jcykuJyxcbiAgICAgICk7XG4gICAgfVxuICB9XG59KTtcblxudGVzdChcIiM1NDUzOiBjb21wbGV0ZS1taWxlc3RvbmUgdXNlcyBhbGwgdG9vbHMgc28gYmFzaCB2ZXJpZmljYXRpb24gaXMgbm90IHBsYW5uaW5nLWRpc3BhdGNoIGJsb2NrZWRcIiwgKCkgPT4ge1xuICBjb25zdCBtYW5pZmVzdCA9IFVOSVRfTUFOSUZFU1RTW1wiY29tcGxldGUtbWlsZXN0b25lXCJdO1xuXG4gIGFzc2VydC5zdHJpY3RFcXVhbChtYW5pZmVzdC50b29scy5tb2RlLCBcImFsbFwiKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChyZXNvbHZlU3ViYWdlbnRQZXJtaXNzaW9uQ29udHJhY3QoXCJjb21wbGV0ZS1taWxlc3RvbmVcIiksIHtcbiAgICBhbGxvd2VkOiB0cnVlLFxuICAgIGFsbG93ZWRTdWJhZ2VudHM6IFtcIipcIl0sXG4gICAgdG9vbHNNb2RlOiBcImFsbFwiLFxuICB9KTtcbiAgLy8gUnVudGltZSBnYXRlLWxldmVsIHJlZ3Jlc3Npb246IHRoZXNlIHZlcmlmaWNhdGlvbiBjb21tYW5kcyB3ZXJlIGJsb2NrZWRcbiAgLy8gdW5kZXIgcGxhbm5pbmctZGlzcGF0Y2ggaW4gIzU0NTM7IGNvbXBsZXRlLW1pbGVzdG9uZSBtdXN0IGJ5cGFzcyB0aGF0IGdhdGUuXG4gIGZvciAoY29uc3QgY21kIG9mIFtcImdpdCBkaWZmIC0tbmFtZS1vbmx5IEhFQUR+MVwiLCBcImdpdCBsb2cgLW4xIC0tb25lbGluZVwiXSkge1xuICAgIGNvbnN0IHJlc3VsdCA9IHNob3VsZEJsb2NrUGxhbm5pbmdVbml0KFxuICAgICAgXCJiYXNoXCIsXG4gICAgICBjbWQsXG4gICAgICBwcm9jZXNzLmN3ZCgpLFxuICAgICAgXCJjb21wbGV0ZS1taWxlc3RvbmVcIixcbiAgICAgIG1hbmlmZXN0LnRvb2xzLFxuICAgICk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgICAgcmVzdWx0LmJsb2NrLFxuICAgICAgZmFsc2UsXG4gICAgICBgc2hvdWxkQmxvY2tQbGFubmluZ1VuaXQgbXVzdCBub3QgYmxvY2sgJHtjbWR9IGZvciBjb21wbGV0ZS1taWxlc3RvbmU6ICR7cmVzdWx0LnJlYXNvbn1gLFxuICAgICk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiIzU4NDM6IHJ1bi11YXQgdXNlcyB2ZXJpZmljYXRpb24gdG9vbHMgcG9saWN5IHNvIGJ1aWxkL3Rlc3QgY29tbWFuZHMgY2FuIHJ1blwiLCAoKSA9PiB7XG4gIGNvbnN0IG1hbmlmZXN0ID0gVU5JVF9NQU5JRkVTVFNbXCJydW4tdWF0XCJdO1xuXG4gIGFzc2VydC5zdHJpY3RFcXVhbChtYW5pZmVzdC50b29scy5tb2RlLCBcInZlcmlmaWNhdGlvblwiKTtcblxuICBjb25zdCBidWlsZFJlc3VsdCA9IHNob3VsZEJsb2NrUGxhbm5pbmdVbml0KFxuICAgIFwiYmFzaFwiLFxuICAgIFwibnBtIHJ1biBidWlsZCAyPiYxXCIsXG4gICAgcHJvY2Vzcy5jd2QoKSxcbiAgICBcInJ1bi11YXRcIixcbiAgICBtYW5pZmVzdC50b29scyxcbiAgKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgIGJ1aWxkUmVzdWx0LmJsb2NrLFxuICAgIGZhbHNlLFxuICAgIGBydW4tdWF0IG11c3QgYWxsb3cgYnVpbGQgdmVyaWZpY2F0aW9uIGNvbW1hbmRzOiAke2J1aWxkUmVzdWx0LnJlYXNvbn1gLFxuICApO1xuXG4gIGNvbnN0IHNvdXJjZVdyaXRlUmVzdWx0ID0gc2hvdWxkQmxvY2tQbGFubmluZ1VuaXQoXG4gICAgXCJlZGl0XCIsXG4gICAgXCJzcmMvbWFpbi50c1wiLFxuICAgIHByb2Nlc3MuY3dkKCksXG4gICAgXCJydW4tdWF0XCIsXG4gICAgbWFuaWZlc3QudG9vbHMsXG4gICk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChzb3VyY2VXcml0ZVJlc3VsdC5ibG9jaywgdHJ1ZSk7XG4gIGFzc2VydC5tYXRjaChzb3VyY2VXcml0ZVJlc3VsdC5yZWFzb24hLCAvdG9vbHMtcG9saWN5IFwidmVyaWZpY2F0aW9uXCIvKTtcbn0pO1xuXG50ZXN0KCdwbGFubmluZy1kaXNwYXRjaCBtb2RlIGlzIHJlc2VydmVkIGZvciBzbGljZS1sZXZlbCBkZWNvbXBvc2l0aW9uIGFuZCBjb21wbGV0aW9uIHVuaXRzJywgKCkgPT4ge1xuICBjb25zdCBhbGxvd2VkRGlzcGF0Y2hVbml0cyA9IG5ldyBTZXQoW1xuICAgIFwicGxhbi1zbGljZVwiLFxuICAgIFwicmVzZWFyY2gtc2xpY2VcIixcbiAgICBcInJlZmluZS1zbGljZVwiLFxuICAgIFwiY29tcGxldGUtc2xpY2VcIixcbiAgICBcImdhdGUtZXZhbHVhdGVcIixcbiAgICAvLyBEZWVwIHBsYW5uaW5nIG1vZGU6IHJlc2VhcmNoLXByb2plY3Qgb3JjaGVzdHJhdGVzIDQgcGFyYWxsZWwgcmVzZWFyY2hcbiAgICAvLyBzdWJhZ2VudHMgKHN0YWNrL2ZlYXR1cmVzL2FyY2hpdGVjdHVyZS9waXRmYWxscykuIFN1YmFnZW50IGRpc3BhdGNoIGlzXG4gICAgLy8gdGhlIHVuaXQncyBjb3JlIG1lY2hhbmlzbSBcdTIwMTQgd2l0aG91dCBpdCwgdGhlIHVuaXQgY2Fubm90IGRvIGl0cyBqb2IuXG4gICAgXCJyZXNlYXJjaC1wcm9qZWN0XCIsXG4gICAgXCJ2YWxpZGF0ZS1taWxlc3RvbmVcIixcbiAgXSk7XG4gIGZvciAoY29uc3QgW3VuaXRUeXBlLCBtYW5pZmVzdF0gb2YgT2JqZWN0LmVudHJpZXMoVU5JVF9NQU5JRkVTVFMpKSB7XG4gICAgY29uc3QgbW9kZSA9IChtYW5pZmVzdCBhcyB7IHRvb2xzOiB7IG1vZGU6IHN0cmluZyB9IH0pLnRvb2xzLm1vZGU7XG4gICAgaWYgKG1vZGUgPT09IFwicGxhbm5pbmctZGlzcGF0Y2hcIikge1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBhbGxvd2VkRGlzcGF0Y2hVbml0cy5oYXModW5pdFR5cGUpLFxuICAgICAgICBgbWFuaWZlc3QgXCIke3VuaXRUeXBlfVwiIGRlY2xhcmVzIHRvb2xzLm1vZGUgPSBcInBsYW5uaW5nLWRpc3BhdGNoXCIgYnV0IGlzIG5vdCBvbiB0aGUgZGlzcGF0Y2gtYWxsb3dlZCBhbGxvd2xpc3QuIGAgK1xuICAgICAgICAncGxhbm5pbmctZGlzcGF0Y2ggaXMgaW50ZW50aW9uYWxseSBuYXJyb3cgXHUyMDE0IGV4dGVuZCB0aGUgYWxsb3dsaXN0IGNvbnNjaW91c2x5IHdoZW4gYSBuZXcgdW5pdCB0eXBlIGdlbnVpbmVseSBiZW5lZml0cyBmcm9tIHN1YmFnZW50IGRlbGVnYXRpb24uJyxcbiAgICAgICk7XG4gICAgfVxuICB9XG59KTtcblxudGVzdCgnVW5pdCBUb29sIENvbnRyYWN0IGV4cG9zZXMgc3ViYWdlbnQgZGlzcGF0Y2ggcGVybWlzc2lvbnMnLCAoKSA9PiB7XG4gIGFzc2VydC5kZWVwRXF1YWwocmVzb2x2ZVN1YmFnZW50UGVybWlzc2lvbkNvbnRyYWN0KFwicGxhbi1zbGljZVwiKSwge1xuICAgIGFsbG93ZWQ6IHRydWUsXG4gICAgYWxsb3dlZFN1YmFnZW50czogW1wic2NvdXRcIiwgXCJwbGFubmVyXCJdLFxuICAgIHRvb2xzTW9kZTogXCJwbGFubmluZy1kaXNwYXRjaFwiLFxuICB9KTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChyZXNvbHZlU3ViYWdlbnRQZXJtaXNzaW9uQ29udHJhY3QoXCJnYXRlLWV2YWx1YXRlXCIpLCB7XG4gICAgYWxsb3dlZDogdHJ1ZSxcbiAgICBhbGxvd2VkU3ViYWdlbnRzOiBbXCJyZXZpZXdlclwiLCBcInNlY3VyaXR5XCIsIFwidGVzdGVyXCJdLFxuICAgIHRvb2xzTW9kZTogXCJwbGFubmluZy1kaXNwYXRjaFwiLFxuICB9KTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChyZXNvbHZlU3ViYWdlbnRQZXJtaXNzaW9uQ29udHJhY3QoXCJkaXNjdXNzLW1pbGVzdG9uZVwiKSwge1xuICAgIGFsbG93ZWQ6IGZhbHNlLFxuICAgIGFsbG93ZWRTdWJhZ2VudHM6IFtdLFxuICAgIHRvb2xzTW9kZTogXCJwbGFubmluZ1wiLFxuICB9KTtcbn0pO1xuXG50ZXN0KCdwbGFubmluZy1kaXNwYXRjaCBtYW5pZmVzdHMgZGVjbGFyZSBub24tZW1wdHkgYWxsb3dlZFN1YmFnZW50cyBsaXN0cycsICgpID0+IHtcbiAgZm9yIChjb25zdCBbdW5pdFR5cGUsIG1hbmlmZXN0XSBvZiBPYmplY3QuZW50cmllcyhVTklUX01BTklGRVNUUykpIHtcbiAgICBpZiAobWFuaWZlc3QudG9vbHMubW9kZSAhPT0gXCJwbGFubmluZy1kaXNwYXRjaFwiKSBjb250aW51ZTtcbiAgICBhc3NlcnQub2soXG4gICAgICBBcnJheS5pc0FycmF5KG1hbmlmZXN0LnRvb2xzLmFsbG93ZWRTdWJhZ2VudHMpICYmIG1hbmlmZXN0LnRvb2xzLmFsbG93ZWRTdWJhZ2VudHMubGVuZ3RoID4gMCxcbiAgICAgIGBtYW5pZmVzdCBcIiR7dW5pdFR5cGV9XCIgaGFzIHBsYW5uaW5nLWRpc3BhdGNoIHBvbGljeSBidXQgbm8gYWxsb3dlZFN1YmFnZW50cyBcdTIwMTQgZXhwbGljaXQgYWxsb3dsaXN0IGlzIHJlcXVpcmVkIGZvciBydW50aW1lIGRpc3BhdGNoIGdhdGluZ2AsXG4gICAgKTtcbiAgICBmb3IgKGNvbnN0IGFnZW50IG9mIG1hbmlmZXN0LnRvb2xzLmFsbG93ZWRTdWJhZ2VudHMpIHtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgdHlwZW9mIGFnZW50ID09PSBcInN0cmluZ1wiICYmIGFnZW50Lmxlbmd0aCA+IDAsXG4gICAgICAgIGBtYW5pZmVzdCBcIiR7dW5pdFR5cGV9XCIgaGFzIGVtcHR5L2ludmFsaWQgYWxsb3dlZFN1YmFnZW50cyBlbnRyeTogJHtKU09OLnN0cmluZ2lmeShhZ2VudCl9YCxcbiAgICAgICk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIEFMTE9XRURfUExBTk5JTkdfRElTUEFUQ0hfQUdFTlRTLmhhcyhhZ2VudCksXG4gICAgICAgIGBtYW5pZmVzdCBcIiR7dW5pdFR5cGV9XCIgYWxsb3dzIFwiJHthZ2VudH1cIiwgYnV0IHRoZSBydW50aW1lIHBsYW5uaW5nLWRpc3BhdGNoIHJlZ2lzdHJ5IHdpbGwgaGFyZC1ibG9jayBpdGAsXG4gICAgICApO1xuICAgIH1cbiAgfVxufSk7XG5cbnRlc3QoJyM0OTM0OiB0b29scy5tb2RlIFwiZG9jc1wiIHJlcXVpcmVzIGEgbm9uLWVtcHR5IGFsbG93ZWRQYXRoR2xvYnMgYXJyYXknLCAoKSA9PiB7XG4gIGZvciAoY29uc3QgW3VuaXRUeXBlLCBtYW5pZmVzdF0gb2YgT2JqZWN0LmVudHJpZXMoVU5JVF9NQU5JRkVTVFMpKSB7XG4gICAgY29uc3QgdG9vbHMgPSAobWFuaWZlc3QgYXMgeyB0b29sczogeyBtb2RlOiBzdHJpbmc7IGFsbG93ZWRQYXRoR2xvYnM/OiByZWFkb25seSBzdHJpbmdbXSB9IH0pLnRvb2xzO1xuICAgIGlmICh0b29scy5tb2RlICE9PSBcImRvY3NcIikgY29udGludWU7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgQXJyYXkuaXNBcnJheSh0b29scy5hbGxvd2VkUGF0aEdsb2JzKSAmJiB0b29scy5hbGxvd2VkUGF0aEdsb2JzLmxlbmd0aCA+IDAsXG4gICAgICBgbWFuaWZlc3QgXCIke3VuaXRUeXBlfVwiIGhhcyBkb2NzIHBvbGljeSBidXQgbm8gYWxsb3dlZFBhdGhHbG9icyBcdTIwMTQgZXhwbGljaXQgYWxsb3ctc2V0IGlzIHJlcXVpcmVkIHNvIHRoZSBlbmZvcmNlbWVudCBsYXllciBkb2Vzbid0IGZhbGwgYmFjayB0byBhIGhhcmRjb2RlZCBkZWZhdWx0YCxcbiAgICApO1xuICAgIGZvciAoY29uc3QgZyBvZiB0b29scy5hbGxvd2VkUGF0aEdsb2JzISkge1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICB0eXBlb2YgZyA9PT0gXCJzdHJpbmdcIiAmJiBnLmxlbmd0aCA+IDAsXG4gICAgICAgIGBtYW5pZmVzdCBcIiR7dW5pdFR5cGV9XCIgaGFzIGVtcHR5L2ludmFsaWQgYWxsb3dlZFBhdGhHbG9icyBlbnRyeTogJHtKU09OLnN0cmluZ2lmeShnKX1gLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQnVkZ2V0IGZsb29yOiBydW4tdWF0ICsgZ2F0ZS1ldmFsdWF0ZSBoaXQgdGhlIHNtYWxsZXN0IGJ1ZGdldCB0aWVyIFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiIzQ3ODIgcGhhc2UgMjogcnVuLXVhdCBhbmQgZ2F0ZS1ldmFsdWF0ZSB1c2UgdGhlIHNtYWxsZXN0IGJ1ZGdldCB0aWVyXCIsICgpID0+IHtcbiAgY29uc3QgdWF0QnVkZ2V0ID0gVU5JVF9NQU5JRkVTVFNbXCJydW4tdWF0XCJdLm1heFN5c3RlbVByb21wdENoYXJzO1xuICBjb25zdCBnYXRlQnVkZ2V0ID0gVU5JVF9NQU5JRkVTVFNbXCJnYXRlLWV2YWx1YXRlXCJdLm1heFN5c3RlbVByb21wdENoYXJzO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwodWF0QnVkZ2V0LCBnYXRlQnVkZ2V0LCBcInJ1bi11YXQgYW5kIGdhdGUtZXZhbHVhdGUgYm90aCB1c2UgQ09NTU9OX0JVREdFVF9TTUFMTFwiKTtcbiAgLy8gVGhleSBzaG91bGQgYmUgdGhlIHRpZ2h0ZXN0IChvciB0aWVkIGZvciB0aWdodGVzdCkgYWNyb3NzIGFsbCBtYW5pZmVzdHNcbiAgZm9yIChjb25zdCBbdW5pdFR5cGUsIG90aGVyXSBvZiBPYmplY3QuZW50cmllcyhVTklUX01BTklGRVNUUykpIHtcbiAgICBhc3NlcnQub2soXG4gICAgICB1YXRCdWRnZXQgPD0gb3RoZXIubWF4U3lzdGVtUHJvbXB0Q2hhcnMsXG4gICAgICBgcnVuLXVhdCBidWRnZXQgKCR7dWF0QnVkZ2V0fSkgc2hvdWxkIGJlIFx1MjI2NCAke3VuaXRUeXBlfSBidWRnZXQgKCR7b3RoZXIubWF4U3lzdGVtUHJvbXB0Q2hhcnN9KWAsXG4gICAgKTtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFFQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBRW5CO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUtLO0FBQ1A7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUlQLEtBQUssMEVBQTBFLE1BQU07QUFDbkYsYUFBVyxZQUFZLGtCQUFrQjtBQUN2QyxXQUFPO0FBQUEsTUFDTCxlQUFlLFFBQVE7QUFBQSxNQUN2QixjQUFjLFFBQVE7QUFBQSxJQUN4QjtBQUFBLEVBQ0Y7QUFDRixDQUFDO0FBRUQsS0FBSyw4RUFBOEUsTUFBTTtBQUN2RixRQUFNLFFBQVEsSUFBSSxJQUFZLGdCQUFxQztBQUNuRSxhQUFXLFlBQVksT0FBTyxLQUFLLGNBQWMsR0FBRztBQUNsRCxXQUFPO0FBQUEsTUFDTCxNQUFNLElBQUksUUFBUTtBQUFBLE1BQ2xCLG1CQUFtQixRQUFRO0FBQUEsSUFDN0I7QUFBQSxFQUNGO0FBQ0YsQ0FBQztBQUlELEtBQUssa0ZBQWtGLE1BQU07QUFDM0YsYUFBVyxZQUFZLGtCQUFrQjtBQUN2QyxXQUFPLEdBQUcsTUFBTSxRQUFRLG9DQUFvQyxRQUFRLENBQUMsQ0FBQztBQUN0RSxXQUFPLEdBQUcsTUFBTSxRQUFRLHNDQUFzQyxRQUFRLENBQUMsQ0FBQztBQUFBLEVBQzFFO0FBQ0YsQ0FBQztBQUlELEtBQUssZ0ZBQWdGLE1BQU07QUFDekYsUUFBTSxZQUFZLElBQUksSUFBWSxhQUFrQztBQUNwRSxhQUFXLENBQUMsVUFBVSxRQUFRLEtBQUssT0FBTyxRQUFRLGNBQWMsR0FBRztBQUNqRSxVQUFNLE1BQXFCO0FBQUEsTUFDekIsR0FBRyxTQUFTLFVBQVU7QUFBQSxNQUN0QixHQUFHLFNBQVMsVUFBVTtBQUFBLE1BQ3RCLEdBQUcsU0FBUyxVQUFVO0FBQUEsSUFDeEI7QUFDQSxlQUFXLE9BQU8sS0FBSztBQUNyQixhQUFPO0FBQUEsUUFDTCxVQUFVLElBQUksR0FBRztBQUFBLFFBQ2pCLGFBQWEsUUFBUSxzQ0FBc0MsR0FBRztBQUFBLE1BQ2hFO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFDRixDQUFDO0FBRUQsS0FBSyxtR0FBbUcsTUFBTTtBQUM1RyxhQUFXLENBQUMsVUFBVSxRQUFRLEtBQUssT0FBTyxRQUFRLGNBQWMsR0FBRztBQUNqRSxVQUFNLFNBQVMsSUFBSSxJQUFZLFNBQVMsVUFBVSxNQUEyQjtBQUM3RSxVQUFNLFVBQVcsU0FBUyxVQUFVLFFBQThCLE9BQU8sT0FBSyxPQUFPLElBQUksQ0FBQyxDQUFDO0FBQzNGLFdBQU87QUFBQSxNQUNMO0FBQUEsTUFDQSxDQUFDO0FBQUEsTUFDRCxhQUFhLFFBQVEsbURBQW1ELFFBQVEsS0FBSyxJQUFJLENBQUM7QUFBQSxJQUM1RjtBQUFBLEVBQ0Y7QUFDRixDQUFDO0FBRUQsS0FBSyxxRUFBcUUsTUFBTTtBQUM5RSxhQUFXLENBQUMsVUFBVSxRQUFRLEtBQUssT0FBTyxRQUFRLGNBQWMsR0FBRztBQUNqRSxXQUFPO0FBQUEsTUFDTCxPQUFPLFNBQVMseUJBQXlCLFlBQVksU0FBUyx1QkFBdUI7QUFBQSxNQUNyRixhQUFhLFFBQVEsdUNBQXVDLFNBQVMsb0JBQW9CO0FBQUEsSUFDM0Y7QUFBQSxFQUNGO0FBQ0YsQ0FBQztBQUVELEtBQUssdUVBQXVFLE1BQU07QUFDaEYsUUFBTSxXQUE4QztBQUFBLElBQ2xELHdCQUF3QjtBQUFBLElBQ3hCLHFCQUFxQjtBQUFBLElBQ3JCLG1CQUFtQjtBQUFBLElBQ25CLHdCQUF3QjtBQUFBLElBQ3hCLHFCQUFxQjtBQUFBLElBQ3JCLG9CQUFvQjtBQUFBLElBQ3BCLHNCQUFzQjtBQUFBLElBQ3RCLGtCQUFrQjtBQUFBLElBQ2xCLGtCQUFrQjtBQUFBLElBQ2xCLGNBQWM7QUFBQSxJQUNkLGdCQUFnQjtBQUFBLElBQ2hCLGdCQUFnQjtBQUFBLElBQ2hCLG9CQUFvQjtBQUFBLElBQ3BCLGdCQUFnQjtBQUFBLElBQ2hCLG9CQUFvQjtBQUFBLElBQ3BCLFdBQVc7QUFBQSxJQUNYLGlCQUFpQjtBQUFBLElBQ2pCLHNCQUFzQjtBQUFBLElBQ3RCLGtCQUFrQjtBQUFBLElBQ2xCLHNCQUFzQjtBQUFBLElBQ3RCLGdCQUFnQjtBQUFBLEVBQ2xCO0FBRUEsU0FBTyxVQUFVLE9BQU8sS0FBSyxRQUFRLEVBQUUsS0FBSyxHQUFHLENBQUMsR0FBRyxnQkFBZ0IsRUFBRSxLQUFLLENBQUM7QUFDM0UsYUFBVyxZQUFZLGtCQUFrQjtBQUN2QyxXQUFPLFlBQVksZUFBZSxRQUFRLEVBQUUsYUFBYSxTQUFTLFFBQVEsQ0FBQztBQUFBLEVBQzdFO0FBQ0YsQ0FBQztBQUVELEtBQUssNkVBQTZFLE1BQU07QUFDdEYsYUFBVyxDQUFDLFVBQVUsUUFBUSxLQUFLLE9BQU8sUUFBUSxjQUFjLEdBQUc7QUFDakUsVUFBTSxJQUFJLFNBQVM7QUFDbkIsWUFBUSxFQUFFLE1BQU07QUFBQSxNQUNkLEtBQUs7QUFBQSxNQUNMLEtBQUs7QUFDSDtBQUFBLE1BQ0YsS0FBSztBQUNILGVBQU87QUFBQSxVQUNMLE1BQU0sUUFBUSxFQUFFLE1BQU0sS0FBSyxFQUFFLE9BQU8sTUFBTSxPQUFLLE9BQU8sTUFBTSxRQUFRO0FBQUEsVUFDcEUsYUFBYSxRQUFRO0FBQUEsUUFDdkI7QUFDQTtBQUFBLE1BQ0YsU0FBUztBQUNQLGNBQU0sY0FBcUI7QUFDM0IsYUFBSztBQUNMLGVBQU8sS0FBSyxhQUFhLFFBQVEsZ0NBQWdDO0FBQUEsTUFDbkU7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUNGLENBQUM7QUFJRCxLQUFLLHdFQUF3RSxNQUFNO0FBQ2pGLFNBQU8sWUFBWSxnQkFBZ0IsNEJBQTRCLEdBQUcsSUFBSTtBQUN4RSxDQUFDO0FBRUQsS0FBSywrRUFBK0UsTUFBTTtBQUN4RixhQUFXLFlBQVksa0JBQWtCO0FBQ3ZDLFVBQU0sSUFBSSxnQkFBZ0IsUUFBUTtBQUNsQyxXQUFPLEdBQUcsR0FBRyxvQkFBb0IsUUFBUSw2QkFBNkI7QUFFdEUsV0FBTyxZQUFZLEdBQUcsZUFBZSxRQUFRLENBQUM7QUFBQSxFQUNoRDtBQUNGLENBQUM7QUFJRCxLQUFLLGdHQUFnRyxNQUFNO0FBQ3pHLFFBQU0sSUFBSSxlQUFlLG9CQUFvQjtBQUM3QyxTQUFPO0FBQUEsSUFDTCxFQUFFLFVBQVUsUUFBUSxTQUFTLGVBQWU7QUFBQSxJQUM1QztBQUFBLEVBQ0Y7QUFDQSxTQUFPO0FBQUEsSUFDTCxDQUFDLEVBQUUsVUFBVSxPQUFPLFNBQVMsZUFBZTtBQUFBLElBQzVDO0FBQUEsRUFDRjtBQUNGLENBQUM7QUFJRCxLQUFLLHVFQUF1RSxNQUFNO0FBQ2hGLGFBQVcsQ0FBQyxVQUFVLFFBQVEsS0FBSyxPQUFPLFFBQVEsY0FBYyxHQUFHO0FBQ2pFLFVBQU0sTUFBZ0I7QUFBQSxNQUNwQixHQUFLLFNBQVMsVUFBK0MsWUFBWSxDQUFDO0FBQUEsTUFDMUUsR0FBSyxTQUE2QyxXQUFXLENBQUM7QUFBQSxJQUNoRTtBQUNBLGVBQVcsTUFBTSxLQUFLO0FBQ3BCLGFBQU87QUFBQSxRQUNMLE9BQU8sT0FBTyxZQUFZLEdBQUcsU0FBUztBQUFBLFFBQ3RDLGFBQWEsUUFBUSwrQ0FBK0MsS0FBSyxVQUFVLEVBQUUsQ0FBQztBQUFBLE1BQ3hGO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFDRixDQUFDO0FBRUQsS0FBSyxzR0FBc0csTUFBTTtBQUMvRyxhQUFXLENBQUMsVUFBVSxRQUFRLEtBQUssT0FBTyxRQUFRLGNBQWMsR0FBRztBQUNqRSxVQUFNLGlCQUFpQixJQUFJO0FBQUEsTUFDdkIsU0FBUyxVQUErQyxZQUFZLENBQUM7QUFBQSxJQUN6RTtBQUNBLFVBQU0sV0FBWSxTQUE2QyxXQUFXLENBQUMsR0FDeEUsT0FBTyxRQUFNLGVBQWUsSUFBSSxFQUFFLENBQUM7QUFDdEMsV0FBTztBQUFBLE1BQ0w7QUFBQSxNQUNBLENBQUM7QUFBQSxNQUNELGFBQWEsUUFBUSxnRUFBZ0UsUUFBUSxLQUFLLElBQUksQ0FBQztBQUFBLElBQ3pHO0FBQUEsRUFDRjtBQUNGLENBQUM7QUFJRCxLQUFLLGlEQUFpRCxNQUFNO0FBQzFELGFBQVcsQ0FBQyxVQUFVLFFBQVEsS0FBSyxPQUFPLFFBQVEsY0FBYyxHQUFHO0FBQ2pFLFVBQU0sU0FBVSxTQUEyQztBQUMzRCxXQUFPO0FBQUEsTUFDTCxVQUFVLE9BQU8sT0FBTyxTQUFTO0FBQUEsTUFDakMsYUFBYSxRQUFRO0FBQUEsSUFDdkI7QUFBQSxFQUNGO0FBQ0YsQ0FBQztBQUVELEtBQUsscURBQXFELE1BQU07QUFDOUQsUUFBTSxhQUFhLG9CQUFJLElBQUksQ0FBQyxPQUFPLGFBQWEsWUFBWSxxQkFBcUIsUUFBUSxjQUFjLENBQUM7QUFDeEcsYUFBVyxDQUFDLFVBQVUsUUFBUSxLQUFLLE9BQU8sUUFBUSxjQUFjLEdBQUc7QUFDakUsVUFBTSxPQUFRLFNBQXlDLE1BQU07QUFDN0QsV0FBTztBQUFBLE1BQ0wsV0FBVyxJQUFJLElBQUk7QUFBQSxNQUNuQixhQUFhLFFBQVEsNkJBQTZCLElBQUksMkJBQXNCLENBQUMsR0FBRyxVQUFVLEVBQUUsS0FBSyxJQUFJLENBQUM7QUFBQSxJQUN4RztBQUFBLEVBQ0Y7QUFDRixDQUFDO0FBRUQsS0FBSywrRUFBK0UsTUFBTTtBQUN4RixRQUFNLGtCQUFrQixvQkFBSSxJQUFJLENBQUMsZ0JBQWdCLG9CQUFvQixvQkFBb0IsQ0FBQztBQUMxRixhQUFXLENBQUMsVUFBVSxRQUFRLEtBQUssT0FBTyxRQUFRLGNBQWMsR0FBRztBQUNqRSxVQUFNLE9BQVEsU0FBeUMsTUFBTTtBQUM3RCxRQUFJLFNBQVMsT0FBTztBQUNsQixhQUFPO0FBQUEsUUFDTCxnQkFBZ0IsSUFBSSxRQUFRO0FBQUEsUUFDNUIsYUFBYSxRQUFRO0FBQUEsTUFHdkI7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUNGLENBQUM7QUFFRCxLQUFLLGtHQUFrRyxNQUFNO0FBQzNHLFFBQU0sV0FBVyxlQUFlLG9CQUFvQjtBQUVwRCxTQUFPLFlBQVksU0FBUyxNQUFNLE1BQU0sS0FBSztBQUM3QyxTQUFPLFVBQVUsa0NBQWtDLG9CQUFvQixHQUFHO0FBQUEsSUFDeEUsU0FBUztBQUFBLElBQ1Qsa0JBQWtCLENBQUMsR0FBRztBQUFBLElBQ3RCLFdBQVc7QUFBQSxFQUNiLENBQUM7QUFHRCxhQUFXLE9BQU8sQ0FBQywrQkFBK0IsdUJBQXVCLEdBQUc7QUFDMUUsVUFBTSxTQUFTO0FBQUEsTUFDYjtBQUFBLE1BQ0E7QUFBQSxNQUNBLFFBQVEsSUFBSTtBQUFBLE1BQ1o7QUFBQSxNQUNBLFNBQVM7QUFBQSxJQUNYO0FBQ0EsV0FBTztBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1A7QUFBQSxNQUNBLDBDQUEwQyxHQUFHLDRCQUE0QixPQUFPLE1BQU07QUFBQSxJQUN4RjtBQUFBLEVBQ0Y7QUFDRixDQUFDO0FBRUQsS0FBSyxnRkFBZ0YsTUFBTTtBQUN6RixRQUFNLFdBQVcsZUFBZSxTQUFTO0FBRXpDLFNBQU8sWUFBWSxTQUFTLE1BQU0sTUFBTSxjQUFjO0FBRXRELFFBQU0sY0FBYztBQUFBLElBQ2xCO0FBQUEsSUFDQTtBQUFBLElBQ0EsUUFBUSxJQUFJO0FBQUEsSUFDWjtBQUFBLElBQ0EsU0FBUztBQUFBLEVBQ1g7QUFDQSxTQUFPO0FBQUEsSUFDTCxZQUFZO0FBQUEsSUFDWjtBQUFBLElBQ0EsbURBQW1ELFlBQVksTUFBTTtBQUFBLEVBQ3ZFO0FBRUEsUUFBTSxvQkFBb0I7QUFBQSxJQUN4QjtBQUFBLElBQ0E7QUFBQSxJQUNBLFFBQVEsSUFBSTtBQUFBLElBQ1o7QUFBQSxJQUNBLFNBQVM7QUFBQSxFQUNYO0FBQ0EsU0FBTyxZQUFZLGtCQUFrQixPQUFPLElBQUk7QUFDaEQsU0FBTyxNQUFNLGtCQUFrQixRQUFTLDZCQUE2QjtBQUN2RSxDQUFDO0FBRUQsS0FBSyx5RkFBeUYsTUFBTTtBQUNsRyxRQUFNLHVCQUF1QixvQkFBSSxJQUFJO0FBQUEsSUFDbkM7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUE7QUFBQTtBQUFBO0FBQUEsSUFJQTtBQUFBLElBQ0E7QUFBQSxFQUNGLENBQUM7QUFDRCxhQUFXLENBQUMsVUFBVSxRQUFRLEtBQUssT0FBTyxRQUFRLGNBQWMsR0FBRztBQUNqRSxVQUFNLE9BQVEsU0FBeUMsTUFBTTtBQUM3RCxRQUFJLFNBQVMscUJBQXFCO0FBQ2hDLGFBQU87QUFBQSxRQUNMLHFCQUFxQixJQUFJLFFBQVE7QUFBQSxRQUNqQyxhQUFhLFFBQVE7QUFBQSxNQUV2QjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0YsQ0FBQztBQUVELEtBQUssNERBQTRELE1BQU07QUFDckUsU0FBTyxVQUFVLGtDQUFrQyxZQUFZLEdBQUc7QUFBQSxJQUNoRSxTQUFTO0FBQUEsSUFDVCxrQkFBa0IsQ0FBQyxTQUFTLFNBQVM7QUFBQSxJQUNyQyxXQUFXO0FBQUEsRUFDYixDQUFDO0FBQ0QsU0FBTyxVQUFVLGtDQUFrQyxlQUFlLEdBQUc7QUFBQSxJQUNuRSxTQUFTO0FBQUEsSUFDVCxrQkFBa0IsQ0FBQyxZQUFZLFlBQVksUUFBUTtBQUFBLElBQ25ELFdBQVc7QUFBQSxFQUNiLENBQUM7QUFDRCxTQUFPLFVBQVUsa0NBQWtDLG1CQUFtQixHQUFHO0FBQUEsSUFDdkUsU0FBUztBQUFBLElBQ1Qsa0JBQWtCLENBQUM7QUFBQSxJQUNuQixXQUFXO0FBQUEsRUFDYixDQUFDO0FBQ0gsQ0FBQztBQUVELEtBQUssd0VBQXdFLE1BQU07QUFDakYsYUFBVyxDQUFDLFVBQVUsUUFBUSxLQUFLLE9BQU8sUUFBUSxjQUFjLEdBQUc7QUFDakUsUUFBSSxTQUFTLE1BQU0sU0FBUyxvQkFBcUI7QUFDakQsV0FBTztBQUFBLE1BQ0wsTUFBTSxRQUFRLFNBQVMsTUFBTSxnQkFBZ0IsS0FBSyxTQUFTLE1BQU0saUJBQWlCLFNBQVM7QUFBQSxNQUMzRixhQUFhLFFBQVE7QUFBQSxJQUN2QjtBQUNBLGVBQVcsU0FBUyxTQUFTLE1BQU0sa0JBQWtCO0FBQ25ELGFBQU87QUFBQSxRQUNMLE9BQU8sVUFBVSxZQUFZLE1BQU0sU0FBUztBQUFBLFFBQzVDLGFBQWEsUUFBUSwrQ0FBK0MsS0FBSyxVQUFVLEtBQUssQ0FBQztBQUFBLE1BQzNGO0FBQ0EsYUFBTztBQUFBLFFBQ0wsaUNBQWlDLElBQUksS0FBSztBQUFBLFFBQzFDLGFBQWEsUUFBUSxhQUFhLEtBQUs7QUFBQSxNQUN6QztBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0YsQ0FBQztBQUVELEtBQUssd0VBQXdFLE1BQU07QUFDakYsYUFBVyxDQUFDLFVBQVUsUUFBUSxLQUFLLE9BQU8sUUFBUSxjQUFjLEdBQUc7QUFDakUsVUFBTSxRQUFTLFNBQStFO0FBQzlGLFFBQUksTUFBTSxTQUFTLE9BQVE7QUFDM0IsV0FBTztBQUFBLE1BQ0wsTUFBTSxRQUFRLE1BQU0sZ0JBQWdCLEtBQUssTUFBTSxpQkFBaUIsU0FBUztBQUFBLE1BQ3pFLGFBQWEsUUFBUTtBQUFBLElBQ3ZCO0FBQ0EsZUFBVyxLQUFLLE1BQU0sa0JBQW1CO0FBQ3ZDLGFBQU87QUFBQSxRQUNMLE9BQU8sTUFBTSxZQUFZLEVBQUUsU0FBUztBQUFBLFFBQ3BDLGFBQWEsUUFBUSwrQ0FBK0MsS0FBSyxVQUFVLENBQUMsQ0FBQztBQUFBLE1BQ3ZGO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFDRixDQUFDO0FBSUQsS0FBSyx5RUFBeUUsTUFBTTtBQUNsRixRQUFNLFlBQVksZUFBZSxTQUFTLEVBQUU7QUFDNUMsUUFBTSxhQUFhLGVBQWUsZUFBZSxFQUFFO0FBQ25ELFNBQU8sWUFBWSxXQUFXLFlBQVksd0RBQXdEO0FBRWxHLGFBQVcsQ0FBQyxVQUFVLEtBQUssS0FBSyxPQUFPLFFBQVEsY0FBYyxHQUFHO0FBQzlELFdBQU87QUFBQSxNQUNMLGFBQWEsTUFBTTtBQUFBLE1BQ25CLG1CQUFtQixTQUFTLHNCQUFpQixRQUFRLFlBQVksTUFBTSxvQkFBb0I7QUFBQSxJQUM3RjtBQUFBLEVBQ0Y7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
