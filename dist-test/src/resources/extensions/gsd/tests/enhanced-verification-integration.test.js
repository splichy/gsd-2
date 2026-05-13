import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runPreExecutionChecks
} from "../pre-execution-checks.js";
import {
  runPostExecutionChecks
} from "../post-execution-checks.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GSD_SRC_DIR = join(__dirname, "..");
const PRE_EXECUTION_TIMEOUT_MS = 2e3;
const POST_EXECUTION_TIMEOUT_MS = 1e3;
function createTask(overrides = {}) {
  return {
    milestone_id: "M001",
    slice_id: "S01",
    id: overrides.id ?? "T01",
    title: overrides.title ?? "Test Task",
    status: overrides.status ?? "pending",
    one_liner: "",
    narrative: "",
    verification_result: "",
    duration: "",
    completed_at: overrides.status === "complete" ? (/* @__PURE__ */ new Date()).toISOString() : null,
    blocker_discovered: false,
    deviations: "",
    known_issues: "",
    key_files: overrides.key_files ?? [],
    key_decisions: [],
    full_summary_md: "",
    description: overrides.description ?? "",
    estimate: "",
    files: overrides.files ?? [],
    verify: "",
    inputs: overrides.inputs ?? [],
    expected_output: overrides.expected_output ?? [],
    observability_impact: "",
    full_plan_md: "",
    sequence: overrides.sequence ?? 0,
    blocker_source: "",
    escalation_pending: 0,
    escalation_awaiting_review: 0,
    escalation_artifact_path: null,
    escalation_override_applied_at: null,
    ...overrides
  };
}
const REAL_GSD_FILES = [
  "gsd-db.ts",
  "auto-verification.ts",
  "pre-execution-checks.ts",
  "post-execution-checks.ts",
  "state.ts",
  "errors.ts",
  "types.ts",
  "cache.ts",
  "atomic-write.ts"
];
function verifyTestFixturesExist() {
  for (const file of REAL_GSD_FILES) {
    const fullPath = join(GSD_SRC_DIR, file);
    if (!existsSync(fullPath)) {
      throw new Error(`Test fixture file does not exist: ${fullPath}`);
    }
  }
}
describe("Enhanced Verification Integration Tests", () => {
  test("test fixture files exist", () => {
    verifyTestFixturesExist();
  });
  describe("Pre-Execution Checks on Real GSD Code", () => {
    test("runs pre-execution checks on realistic tasks referencing real files", async () => {
      const tasks = [
        createTask({
          id: "T01",
          sequence: 0,
          title: "Add validation to gsd-db",
          description: `
## Steps
1. Update src/resources/extensions/gsd/gsd-db.ts to add validation
2. Read from src/resources/extensions/gsd/types.ts for type definitions
3. Update src/resources/extensions/gsd/errors.ts with new error types
4. Run tests to verify changes
          `.trim(),
          files: REAL_GSD_FILES.slice(0, 4).map((f) => join(GSD_SRC_DIR, f)),
          inputs: [
            join(GSD_SRC_DIR, "types.ts"),
            join(GSD_SRC_DIR, "errors.ts")
          ],
          expected_output: [
            join(GSD_SRC_DIR, "gsd-db.ts")
          ]
        })
      ];
      const start = performance.now();
      const result = await runPreExecutionChecks(tasks, GSD_SRC_DIR);
      const duration = performance.now() - start;
      const blockingFailures = result.checks.filter((c) => !c.passed && c.blocking);
      assert.equal(
        blockingFailures.length,
        0,
        `Expected zero blocking failures, got: ${JSON.stringify(blockingFailures, null, 2)}`
      );
      assert.notEqual(result.status, "fail", "Pre-execution checks should not fail on real GSD code");
      assert.ok(
        duration < PRE_EXECUTION_TIMEOUT_MS,
        `Pre-execution checks took ${duration.toFixed(0)}ms, expected <${PRE_EXECUTION_TIMEOUT_MS}ms`
      );
    });
    test("handles task with code block references to real packages", async () => {
      const tasks = [
        createTask({
          id: "T01",
          sequence: 0,
          title: "Implement file watcher",
          description: `
## Implementation

\`\`\`typescript
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

// Use existing GSD types
import type { TaskRow } from "./gsd-db.js";
\`\`\`

Update the file watcher to use these imports.
          `.trim(),
          files: [join(GSD_SRC_DIR, "auto-verification.ts")]
        })
      ];
      const start = performance.now();
      const result = await runPreExecutionChecks(tasks, GSD_SRC_DIR);
      const duration = performance.now() - start;
      const blockingFailures = result.checks.filter((c) => !c.passed && c.blocking);
      assert.equal(
        blockingFailures.length,
        0,
        `Unexpected blocking failures: ${JSON.stringify(blockingFailures, null, 2)}`
      );
      assert.ok(
        duration < PRE_EXECUTION_TIMEOUT_MS,
        `Pre-execution checks took ${duration.toFixed(0)}ms, expected <${PRE_EXECUTION_TIMEOUT_MS}ms`
      );
    });
    test("handles multi-task sequence with file dependencies", async () => {
      const tasks = [
        createTask({
          id: "T01",
          sequence: 0,
          title: "Create types file",
          status: "complete",
          expected_output: [join(GSD_SRC_DIR, "types.ts")]
        }),
        createTask({
          id: "T02",
          sequence: 1,
          title: "Use types in implementation",
          description: `
Read the types from src/resources/extensions/gsd/types.ts and use them.
          `.trim(),
          inputs: [join(GSD_SRC_DIR, "types.ts")],
          files: [join(GSD_SRC_DIR, "gsd-db.ts")]
        })
      ];
      const start = performance.now();
      const result = await runPreExecutionChecks(tasks, GSD_SRC_DIR);
      const duration = performance.now() - start;
      const blockingFailures = result.checks.filter((c) => !c.passed && c.blocking);
      assert.equal(
        blockingFailures.length,
        0,
        `Unexpected blocking failures: ${JSON.stringify(blockingFailures, null, 2)}`
      );
      assert.ok(
        duration < PRE_EXECUTION_TIMEOUT_MS,
        `Pre-execution checks took ${duration.toFixed(0)}ms, expected <${PRE_EXECUTION_TIMEOUT_MS}ms`
      );
    });
  });
  describe("Post-Execution Checks on Real GSD Code", () => {
    test("runs post-execution checks on real GSD source files", () => {
      const completedTask = createTask({
        id: "T01",
        title: "Update gsd-db validation",
        status: "complete",
        key_files: [
          join(GSD_SRC_DIR, "gsd-db.ts"),
          join(GSD_SRC_DIR, "types.ts")
        ]
      });
      const start = performance.now();
      const result = runPostExecutionChecks(completedTask, [], GSD_SRC_DIR);
      const duration = performance.now() - start;
      const blockingFailures = result.checks.filter((c) => !c.passed && c.blocking);
      assert.equal(
        blockingFailures.length,
        0,
        `Expected zero blocking failures, got: ${JSON.stringify(blockingFailures, null, 2)}`
      );
      assert.notEqual(result.status, "fail", "Post-execution checks should not fail on real GSD code");
      assert.ok(
        duration < POST_EXECUTION_TIMEOUT_MS,
        `Post-execution checks took ${duration.toFixed(0)}ms, expected <${POST_EXECUTION_TIMEOUT_MS}ms`
      );
    });
    test("analyzes imports in real TypeScript files", () => {
      const completedTask = createTask({
        id: "T02",
        title: "Verify auto-verification imports",
        status: "complete",
        key_files: [join(GSD_SRC_DIR, "auto-verification.ts")]
      });
      const start = performance.now();
      const result = runPostExecutionChecks(completedTask, [], GSD_SRC_DIR);
      const duration = performance.now() - start;
      const blockingFailures = result.checks.filter((c) => !c.passed && c.blocking);
      assert.equal(
        blockingFailures.length,
        0,
        `Unexpected blocking failures: ${JSON.stringify(blockingFailures, null, 2)}`
      );
      assert.ok(
        duration < POST_EXECUTION_TIMEOUT_MS,
        `Post-execution checks took ${duration.toFixed(0)}ms, expected <${POST_EXECUTION_TIMEOUT_MS}ms`
      );
    });
    test("handles multi-file task with cross-file dependencies", () => {
      const completedTask = createTask({
        id: "T03",
        title: "Refactor state management",
        status: "complete",
        key_files: [
          join(GSD_SRC_DIR, "state.ts"),
          join(GSD_SRC_DIR, "gsd-db.ts"),
          join(GSD_SRC_DIR, "cache.ts")
        ]
      });
      const start = performance.now();
      const result = runPostExecutionChecks(completedTask, [], GSD_SRC_DIR);
      const duration = performance.now() - start;
      const blockingFailures = result.checks.filter((c) => !c.passed && c.blocking);
      assert.equal(
        blockingFailures.length,
        0,
        `Unexpected blocking failures: ${JSON.stringify(blockingFailures, null, 2)}`
      );
      assert.ok(
        duration < POST_EXECUTION_TIMEOUT_MS,
        `Post-execution checks took ${duration.toFixed(0)}ms, expected <${POST_EXECUTION_TIMEOUT_MS}ms`
      );
    });
    test("handles task sequence with signature analysis", () => {
      const priorTasks = [
        createTask({
          id: "T01",
          sequence: 0,
          title: "Define TaskRow interface",
          status: "complete",
          key_files: [join(GSD_SRC_DIR, "gsd-db.ts")]
        })
      ];
      const completedTask = createTask({
        id: "T02",
        sequence: 1,
        title: "Use TaskRow in state module",
        status: "complete",
        key_files: [join(GSD_SRC_DIR, "state.ts")]
      });
      const start = performance.now();
      const result = runPostExecutionChecks(completedTask, priorTasks, GSD_SRC_DIR);
      const duration = performance.now() - start;
      const blockingFailures = result.checks.filter((c) => !c.passed && c.blocking);
      assert.equal(
        blockingFailures.length,
        0,
        `Unexpected blocking failures: ${JSON.stringify(blockingFailures, null, 2)}`
      );
      assert.ok(
        duration < POST_EXECUTION_TIMEOUT_MS,
        `Post-execution checks took ${duration.toFixed(0)}ms, expected <${POST_EXECUTION_TIMEOUT_MS}ms`
      );
    });
  });
  describe("Combined Pre and Post Execution Flow", () => {
    test("full verification flow on realistic task lifecycle", async () => {
      const tasks = [
        createTask({
          id: "T01",
          sequence: 0,
          title: "Implement enhanced verification",
          status: "pending",
          description: `
## Steps
1. Update pre-execution-checks.ts with new validation
2. Update post-execution-checks.ts with signature analysis
3. Add integration tests

\`\`\`typescript
import { runPreExecutionChecks } from "./pre-execution-checks.js";
import { runPostExecutionChecks } from "./post-execution-checks.js";
\`\`\`
          `.trim(),
          files: [
            join(GSD_SRC_DIR, "pre-execution-checks.ts"),
            join(GSD_SRC_DIR, "post-execution-checks.ts")
          ],
          inputs: [
            join(GSD_SRC_DIR, "types.ts"),
            join(GSD_SRC_DIR, "gsd-db.ts")
          ],
          expected_output: [
            join(GSD_SRC_DIR, "tests/enhanced-verification-integration.test.ts")
          ]
        })
      ];
      const preStart = performance.now();
      const preResult = await runPreExecutionChecks(tasks, GSD_SRC_DIR);
      const preDuration = performance.now() - preStart;
      const preBlockingFailures = preResult.checks.filter((c) => !c.passed && c.blocking);
      assert.equal(
        preBlockingFailures.length,
        0,
        `Pre-execution had blocking failures: ${JSON.stringify(preBlockingFailures, null, 2)}`
      );
      assert.ok(
        preDuration < PRE_EXECUTION_TIMEOUT_MS,
        `Pre-execution took ${preDuration.toFixed(0)}ms, expected <${PRE_EXECUTION_TIMEOUT_MS}ms`
      );
      const completedTask = createTask({
        ...tasks[0],
        status: "complete",
        key_files: tasks[0].files
      });
      const postStart = performance.now();
      const postResult = runPostExecutionChecks(completedTask, [], GSD_SRC_DIR);
      const postDuration = performance.now() - postStart;
      const postBlockingFailures = postResult.checks.filter((c) => !c.passed && c.blocking);
      assert.equal(
        postBlockingFailures.length,
        0,
        `Post-execution had blocking failures: ${JSON.stringify(postBlockingFailures, null, 2)}`
      );
      assert.ok(
        postDuration < POST_EXECUTION_TIMEOUT_MS,
        `Post-execution took ${postDuration.toFixed(0)}ms, expected <${POST_EXECUTION_TIMEOUT_MS}ms`
      );
    });
    test("handles large number of files without timeout", () => {
      const allGsdFiles = REAL_GSD_FILES.map((f) => join(GSD_SRC_DIR, f));
      const task = createTask({
        id: "T01",
        title: "Large refactor touching many files",
        status: "complete",
        key_files: allGsdFiles,
        files: allGsdFiles
      });
      const start = performance.now();
      const result = runPostExecutionChecks(task, [], GSD_SRC_DIR);
      const duration = performance.now() - start;
      const blockingFailures = result.checks.filter((c) => !c.passed && c.blocking);
      assert.equal(
        blockingFailures.length,
        0,
        `Unexpected blocking failures: ${JSON.stringify(blockingFailures, null, 2)}`
      );
      assert.ok(
        duration < POST_EXECUTION_TIMEOUT_MS * 2,
        // Allow 2x for stress test
        `Multi-file post-execution took ${duration.toFixed(0)}ms, expected <${POST_EXECUTION_TIMEOUT_MS * 2}ms`
      );
    });
  });
  describe("Warning Quality", () => {
    test("warnings on real code are actionable, not spurious", () => {
      const task = createTask({
        id: "T01",
        title: "Review code quality",
        status: "complete",
        key_files: [
          join(GSD_SRC_DIR, "pre-execution-checks.ts"),
          join(GSD_SRC_DIR, "post-execution-checks.ts")
        ]
      });
      const result = runPostExecutionChecks(task, [], GSD_SRC_DIR);
      const warnings = result.checks.filter(
        (c) => !c.passed && !c.blocking || c.passed && c.message?.startsWith("Warning:")
      );
      assert.ok(
        warnings.length <= 10,
        `Too many warnings (${warnings.length}) suggests overly aggressive checks: ${JSON.stringify(warnings, null, 2)}`
      );
      for (const warning of warnings) {
        assert.ok(warning.category, "Warning missing category");
        assert.ok(warning.message, "Warning missing message");
        assert.ok(
          warning.message.length > 10,
          `Warning message too short to be actionable: "${warning.message}"`
        );
      }
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9lbmhhbmNlZC12ZXJpZmljYXRpb24taW50ZWdyYXRpb24udGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBlbmhhbmNlZC12ZXJpZmljYXRpb24taW50ZWdyYXRpb24udGVzdC50cyBcdTIwMTQgSW50ZWdyYXRpb24gdGVzdHMgZm9yIGVuaGFuY2VkIHZlcmlmaWNhdGlvbi5cbiAqXG4gKiBFeGVyY2lzZXMgYWxsIDcgZW5oYW5jZWQgdmVyaWZpY2F0aW9uIGNoZWNrcyBhZ2FpbnN0IEdTRC0yJ3MgYWN0dWFsIHNvdXJjZSBmaWxlcy5cbiAqIFRoaXMgcHJvdmVzOlxuICogICAtIFIwMTI6IE5vIGZhbHNlIHBvc2l0aXZlcyBvbiBwcm9kdWN0aW9uIGNvZGVcbiAqICAgLSBSMDEzOiBTcGVlZCB0YXJnZXRzIG1ldCAoPDIwMDBtcyBwcmUtZXhlY3V0aW9uLCA8MTAwMG1zIHBvc3QtZXhlY3V0aW9uIHBlciB0YXNrKVxuICpcbiAqIFRoZSB0ZXN0IGNvbnN0cnVjdHMgcmVhbGlzdGljIFRhc2tSb3cgZml4dHVyZXMgdGhhdCByZWZlcmVuY2UgcmVhbCBHU0Qgc291cmNlIGZpbGVzLFxuICogdGhlbiBydW5zIGJvdGggcHJlLWV4ZWN1dGlvbiBhbmQgcG9zdC1leGVjdXRpb24gY2hlY2tzIGFnYWluc3QgdGhlbS5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCBkaXJuYW1lIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuXG5pbXBvcnQge1xuICBydW5QcmVFeGVjdXRpb25DaGVja3MsXG4gIHR5cGUgUHJlRXhlY3V0aW9uUmVzdWx0LFxufSBmcm9tIFwiLi4vcHJlLWV4ZWN1dGlvbi1jaGVja3MudHNcIjtcbmltcG9ydCB7XG4gIHJ1blBvc3RFeGVjdXRpb25DaGVja3MsXG4gIHR5cGUgUG9zdEV4ZWN1dGlvblJlc3VsdCxcbn0gZnJvbSBcIi4uL3Bvc3QtZXhlY3V0aW9uLWNoZWNrcy50c1wiO1xuaW1wb3J0IHR5cGUgeyBUYXNrUm93IH0gZnJvbSBcIi4uL2dzZC1kYi50c1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ29uc3RhbnRzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCBfX2ZpbGVuYW1lID0gZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpO1xuY29uc3QgX19kaXJuYW1lID0gZGlybmFtZShfX2ZpbGVuYW1lKTtcblxuLy8gUGF0aCB0byB0aGUgR1NEIGV4dGVuc2lvbiBzb3VyY2UgZGlyZWN0b3J5IChyZWxhdGl2ZSB0byB0ZXN0IGZpbGUpXG5jb25zdCBHU0RfU1JDX0RJUiA9IGpvaW4oX19kaXJuYW1lLCBcIi4uXCIpO1xuXG4vLyBTcGVlZCB0YXJnZXRzIGZyb20gUjAxM1xuY29uc3QgUFJFX0VYRUNVVElPTl9USU1FT1VUX01TID0gMjAwMDtcbmNvbnN0IFBPU1RfRVhFQ1VUSU9OX1RJTUVPVVRfTVMgPSAxMDAwO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCBGaXh0dXJlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBDcmVhdGUgYSBtaW5pbWFsIFRhc2tSb3cgZm9yIHRlc3RpbmcuXG4gKi9cbmZ1bmN0aW9uIGNyZWF0ZVRhc2sob3ZlcnJpZGVzOiBQYXJ0aWFsPFRhc2tSb3c+ID0ge30pOiBUYXNrUm93IHtcbiAgcmV0dXJuIHtcbiAgICBtaWxlc3RvbmVfaWQ6IFwiTTAwMVwiLFxuICAgIHNsaWNlX2lkOiBcIlMwMVwiLFxuICAgIGlkOiBvdmVycmlkZXMuaWQgPz8gXCJUMDFcIixcbiAgICB0aXRsZTogb3ZlcnJpZGVzLnRpdGxlID8/IFwiVGVzdCBUYXNrXCIsXG4gICAgc3RhdHVzOiBvdmVycmlkZXMuc3RhdHVzID8/IFwicGVuZGluZ1wiLFxuICAgIG9uZV9saW5lcjogXCJcIixcbiAgICBuYXJyYXRpdmU6IFwiXCIsXG4gICAgdmVyaWZpY2F0aW9uX3Jlc3VsdDogXCJcIixcbiAgICBkdXJhdGlvbjogXCJcIixcbiAgICBjb21wbGV0ZWRfYXQ6IG92ZXJyaWRlcy5zdGF0dXMgPT09IFwiY29tcGxldGVcIiA/IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSA6IG51bGwsXG4gICAgYmxvY2tlcl9kaXNjb3ZlcmVkOiBmYWxzZSxcbiAgICBkZXZpYXRpb25zOiBcIlwiLFxuICAgIGtub3duX2lzc3VlczogXCJcIixcbiAgICBrZXlfZmlsZXM6IG92ZXJyaWRlcy5rZXlfZmlsZXMgPz8gW10sXG4gICAga2V5X2RlY2lzaW9uczogW10sXG4gICAgZnVsbF9zdW1tYXJ5X21kOiBcIlwiLFxuICAgIGRlc2NyaXB0aW9uOiBvdmVycmlkZXMuZGVzY3JpcHRpb24gPz8gXCJcIixcbiAgICBlc3RpbWF0ZTogXCJcIixcbiAgICBmaWxlczogb3ZlcnJpZGVzLmZpbGVzID8/IFtdLFxuICAgIHZlcmlmeTogXCJcIixcbiAgICBpbnB1dHM6IG92ZXJyaWRlcy5pbnB1dHMgPz8gW10sXG4gICAgZXhwZWN0ZWRfb3V0cHV0OiBvdmVycmlkZXMuZXhwZWN0ZWRfb3V0cHV0ID8/IFtdLFxuICAgIG9ic2VydmFiaWxpdHlfaW1wYWN0OiBcIlwiLFxuICAgIGZ1bGxfcGxhbl9tZDogXCJcIixcbiAgICBzZXF1ZW5jZTogb3ZlcnJpZGVzLnNlcXVlbmNlID8/IDAsXG4gICAgYmxvY2tlcl9zb3VyY2U6IFwiXCIsXG4gICAgZXNjYWxhdGlvbl9wZW5kaW5nOiAwLFxuICAgIGVzY2FsYXRpb25fYXdhaXRpbmdfcmV2aWV3OiAwLFxuICAgIGVzY2FsYXRpb25fYXJ0aWZhY3RfcGF0aDogbnVsbCxcbiAgICBlc2NhbGF0aW9uX292ZXJyaWRlX2FwcGxpZWRfYXQ6IG51bGwsXG4gICAgLi4ub3ZlcnJpZGVzLFxuICB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmVhbCBHU0QgU291cmNlIEZpbGVzIGZvciBUZXN0aW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vLyBUaGVzZSBhcmUgYWN0dWFsIEdTRCBleHRlbnNpb24gc291cmNlIGZpbGVzIHRoYXQgZXhpc3QgaW4gdGhlIGNvZGViYXNlXG5jb25zdCBSRUFMX0dTRF9GSUxFUyA9IFtcbiAgXCJnc2QtZGIudHNcIixcbiAgXCJhdXRvLXZlcmlmaWNhdGlvbi50c1wiLFxuICBcInByZS1leGVjdXRpb24tY2hlY2tzLnRzXCIsXG4gIFwicG9zdC1leGVjdXRpb24tY2hlY2tzLnRzXCIsXG4gIFwic3RhdGUudHNcIixcbiAgXCJlcnJvcnMudHNcIixcbiAgXCJ0eXBlcy50c1wiLFxuICBcImNhY2hlLnRzXCIsXG4gIFwiYXRvbWljLXdyaXRlLnRzXCIsXG5dO1xuXG4vLyBWZXJpZnkgdGhlIHRlc3QgZml4dHVyZSBmaWxlcyBhY3R1YWxseSBleGlzdFxuZnVuY3Rpb24gdmVyaWZ5VGVzdEZpeHR1cmVzRXhpc3QoKTogdm9pZCB7XG4gIGZvciAoY29uc3QgZmlsZSBvZiBSRUFMX0dTRF9GSUxFUykge1xuICAgIGNvbnN0IGZ1bGxQYXRoID0gam9pbihHU0RfU1JDX0RJUiwgZmlsZSk7XG4gICAgaWYgKCFleGlzdHNTeW5jKGZ1bGxQYXRoKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBUZXN0IGZpeHR1cmUgZmlsZSBkb2VzIG5vdCBleGlzdDogJHtmdWxsUGF0aH1gKTtcbiAgICB9XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEludGVncmF0aW9uIFRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIkVuaGFuY2VkIFZlcmlmaWNhdGlvbiBJbnRlZ3JhdGlvbiBUZXN0c1wiLCAoKSA9PiB7XG4gIC8vIFZlcmlmeSBmaXh0dXJlcyBiZWZvcmUgcnVubmluZyB0ZXN0c1xuICB0ZXN0KFwidGVzdCBmaXh0dXJlIGZpbGVzIGV4aXN0XCIsICgpID0+IHtcbiAgICB2ZXJpZnlUZXN0Rml4dHVyZXNFeGlzdCgpO1xuICB9KTtcblxuICBkZXNjcmliZShcIlByZS1FeGVjdXRpb24gQ2hlY2tzIG9uIFJlYWwgR1NEIENvZGVcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJydW5zIHByZS1leGVjdXRpb24gY2hlY2tzIG9uIHJlYWxpc3RpYyB0YXNrcyByZWZlcmVuY2luZyByZWFsIGZpbGVzXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIC8vIFNpbXVsYXRlIHRhc2tzIHRoYXQgcmVmZXJlbmNlIHJlYWwgR1NEIHNvdXJjZSBmaWxlc1xuICAgICAgY29uc3QgdGFza3M6IFRhc2tSb3dbXSA9IFtcbiAgICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgICAgc2VxdWVuY2U6IDAsXG4gICAgICAgICAgdGl0bGU6IFwiQWRkIHZhbGlkYXRpb24gdG8gZ3NkLWRiXCIsXG4gICAgICAgICAgZGVzY3JpcHRpb246IGBcbiMjIFN0ZXBzXG4xLiBVcGRhdGUgc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9nc2QtZGIudHMgdG8gYWRkIHZhbGlkYXRpb25cbjIuIFJlYWQgZnJvbSBzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL3R5cGVzLnRzIGZvciB0eXBlIGRlZmluaXRpb25zXG4zLiBVcGRhdGUgc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9lcnJvcnMudHMgd2l0aCBuZXcgZXJyb3IgdHlwZXNcbjQuIFJ1biB0ZXN0cyB0byB2ZXJpZnkgY2hhbmdlc1xuICAgICAgICAgIGAudHJpbSgpLFxuICAgICAgICAgIGZpbGVzOiBSRUFMX0dTRF9GSUxFUy5zbGljZSgwLCA0KS5tYXAoKGYpID0+IGpvaW4oR1NEX1NSQ19ESVIsIGYpKSxcbiAgICAgICAgICBpbnB1dHM6IFtcbiAgICAgICAgICAgIGpvaW4oR1NEX1NSQ19ESVIsIFwidHlwZXMudHNcIiksXG4gICAgICAgICAgICBqb2luKEdTRF9TUkNfRElSLCBcImVycm9ycy50c1wiKSxcbiAgICAgICAgICBdLFxuICAgICAgICAgIGV4cGVjdGVkX291dHB1dDogW1xuICAgICAgICAgICAgam9pbihHU0RfU1JDX0RJUiwgXCJnc2QtZGIudHNcIiksXG4gICAgICAgICAgXSxcbiAgICAgICAgfSksXG4gICAgICBdO1xuXG4gICAgICBjb25zdCBzdGFydCA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUHJlRXhlY3V0aW9uQ2hlY2tzKHRhc2tzLCBHU0RfU1JDX0RJUik7XG4gICAgICBjb25zdCBkdXJhdGlvbiA9IHBlcmZvcm1hbmNlLm5vdygpIC0gc3RhcnQ7XG5cbiAgICAgIC8vIFIwMTI6IE5vIGJsb2NraW5nIGZhaWx1cmVzIChmYWxzZSBwb3NpdGl2ZXMpIG9uIHByb2R1Y3Rpb24gY29kZVxuICAgICAgY29uc3QgYmxvY2tpbmdGYWlsdXJlcyA9IHJlc3VsdC5jaGVja3MuZmlsdGVyKChjKSA9PiAhYy5wYXNzZWQgJiYgYy5ibG9ja2luZyk7XG4gICAgICBhc3NlcnQuZXF1YWwoXG4gICAgICAgIGJsb2NraW5nRmFpbHVyZXMubGVuZ3RoLFxuICAgICAgICAwLFxuICAgICAgICBgRXhwZWN0ZWQgemVybyBibG9ja2luZyBmYWlsdXJlcywgZ290OiAke0pTT04uc3RyaW5naWZ5KGJsb2NraW5nRmFpbHVyZXMsIG51bGwsIDIpfWBcbiAgICAgICk7XG5cbiAgICAgIC8vIE92ZXJhbGwgc3RhdHVzIHNob3VsZCBub3QgYmUgZmFpbFxuICAgICAgYXNzZXJ0Lm5vdEVxdWFsKHJlc3VsdC5zdGF0dXMsIFwiZmFpbFwiLCBcIlByZS1leGVjdXRpb24gY2hlY2tzIHNob3VsZCBub3QgZmFpbCBvbiByZWFsIEdTRCBjb2RlXCIpO1xuXG4gICAgICAvLyBSMDEzOiBTcGVlZCB0YXJnZXQgbWV0XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIGR1cmF0aW9uIDwgUFJFX0VYRUNVVElPTl9USU1FT1VUX01TLFxuICAgICAgICBgUHJlLWV4ZWN1dGlvbiBjaGVja3MgdG9vayAke2R1cmF0aW9uLnRvRml4ZWQoMCl9bXMsIGV4cGVjdGVkIDwke1BSRV9FWEVDVVRJT05fVElNRU9VVF9NU31tc2BcbiAgICAgICk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiaGFuZGxlcyB0YXNrIHdpdGggY29kZSBibG9jayByZWZlcmVuY2VzIHRvIHJlYWwgcGFja2FnZXNcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgLy8gVGFzayBkZXNjcmlwdGlvbiB3aXRoIHJlYWxpc3RpYyBjb2RlIGJsb2NrcyB1c2luZyBhY3R1YWwgTm9kZS5qcyBidWlsdC1pbnNcbiAgICAgIGNvbnN0IHRhc2tzOiBUYXNrUm93W10gPSBbXG4gICAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICAgIHNlcXVlbmNlOiAwLFxuICAgICAgICAgIHRpdGxlOiBcIkltcGxlbWVudCBmaWxlIHdhdGNoZXJcIixcbiAgICAgICAgICBkZXNjcmlwdGlvbjogYFxuIyMgSW1wbGVtZW50YXRpb25cblxuXFxgXFxgXFxgdHlwZXNjcmlwdFxuaW1wb3J0IHsgcmVhZEZpbGVTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4sIGRpcm5hbWUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcblxuLy8gVXNlIGV4aXN0aW5nIEdTRCB0eXBlc1xuaW1wb3J0IHR5cGUgeyBUYXNrUm93IH0gZnJvbSBcIi4vZ3NkLWRiLnRzXCI7XG5cXGBcXGBcXGBcblxuVXBkYXRlIHRoZSBmaWxlIHdhdGNoZXIgdG8gdXNlIHRoZXNlIGltcG9ydHMuXG4gICAgICAgICAgYC50cmltKCksXG4gICAgICAgICAgZmlsZXM6IFtqb2luKEdTRF9TUkNfRElSLCBcImF1dG8tdmVyaWZpY2F0aW9uLnRzXCIpXSxcbiAgICAgICAgfSksXG4gICAgICBdO1xuXG4gICAgICBjb25zdCBzdGFydCA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUHJlRXhlY3V0aW9uQ2hlY2tzKHRhc2tzLCBHU0RfU1JDX0RJUik7XG4gICAgICBjb25zdCBkdXJhdGlvbiA9IHBlcmZvcm1hbmNlLm5vdygpIC0gc3RhcnQ7XG5cbiAgICAgIC8vIE5vIGJsb2NraW5nIGZhaWx1cmVzXG4gICAgICBjb25zdCBibG9ja2luZ0ZhaWx1cmVzID0gcmVzdWx0LmNoZWNrcy5maWx0ZXIoKGMpID0+ICFjLnBhc3NlZCAmJiBjLmJsb2NraW5nKTtcbiAgICAgIGFzc2VydC5lcXVhbChcbiAgICAgICAgYmxvY2tpbmdGYWlsdXJlcy5sZW5ndGgsXG4gICAgICAgIDAsXG4gICAgICAgIGBVbmV4cGVjdGVkIGJsb2NraW5nIGZhaWx1cmVzOiAke0pTT04uc3RyaW5naWZ5KGJsb2NraW5nRmFpbHVyZXMsIG51bGwsIDIpfWBcbiAgICAgICk7XG5cbiAgICAgIC8vIFNwZWVkIHRhcmdldCBtZXRcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgZHVyYXRpb24gPCBQUkVfRVhFQ1VUSU9OX1RJTUVPVVRfTVMsXG4gICAgICAgIGBQcmUtZXhlY3V0aW9uIGNoZWNrcyB0b29rICR7ZHVyYXRpb24udG9GaXhlZCgwKX1tcywgZXhwZWN0ZWQgPCR7UFJFX0VYRUNVVElPTl9USU1FT1VUX01TfW1zYFxuICAgICAgKTtcbiAgICB9KTtcblxuICAgIHRlc3QoXCJoYW5kbGVzIG11bHRpLXRhc2sgc2VxdWVuY2Ugd2l0aCBmaWxlIGRlcGVuZGVuY2llc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgICAvLyBTaW11bGF0ZSBhIHJlYWxpc3RpYyB0YXNrIHNlcXVlbmNlIHdoZXJlIFQwMiBkZXBlbmRzIG9uIFQwMSdzIG91dHB1dFxuICAgICAgY29uc3QgdGFza3M6IFRhc2tSb3dbXSA9IFtcbiAgICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgICAgc2VxdWVuY2U6IDAsXG4gICAgICAgICAgdGl0bGU6IFwiQ3JlYXRlIHR5cGVzIGZpbGVcIixcbiAgICAgICAgICBzdGF0dXM6IFwiY29tcGxldGVcIixcbiAgICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtqb2luKEdTRF9TUkNfRElSLCBcInR5cGVzLnRzXCIpXSxcbiAgICAgICAgfSksXG4gICAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICAgIGlkOiBcIlQwMlwiLFxuICAgICAgICAgIHNlcXVlbmNlOiAxLFxuICAgICAgICAgIHRpdGxlOiBcIlVzZSB0eXBlcyBpbiBpbXBsZW1lbnRhdGlvblwiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBgXG5SZWFkIHRoZSB0eXBlcyBmcm9tIHNyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvdHlwZXMudHMgYW5kIHVzZSB0aGVtLlxuICAgICAgICAgIGAudHJpbSgpLFxuICAgICAgICAgIGlucHV0czogW2pvaW4oR1NEX1NSQ19ESVIsIFwidHlwZXMudHNcIildLFxuICAgICAgICAgIGZpbGVzOiBbam9pbihHU0RfU1JDX0RJUiwgXCJnc2QtZGIudHNcIildLFxuICAgICAgICB9KSxcbiAgICAgIF07XG5cbiAgICAgIGNvbnN0IHN0YXJ0ID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5QcmVFeGVjdXRpb25DaGVja3ModGFza3MsIEdTRF9TUkNfRElSKTtcbiAgICAgIGNvbnN0IGR1cmF0aW9uID0gcGVyZm9ybWFuY2Uubm93KCkgLSBzdGFydDtcblxuICAgICAgLy8gTm8gYmxvY2tpbmcgZmFpbHVyZXNcbiAgICAgIGNvbnN0IGJsb2NraW5nRmFpbHVyZXMgPSByZXN1bHQuY2hlY2tzLmZpbHRlcigoYykgPT4gIWMucGFzc2VkICYmIGMuYmxvY2tpbmcpO1xuICAgICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgICBibG9ja2luZ0ZhaWx1cmVzLmxlbmd0aCxcbiAgICAgICAgMCxcbiAgICAgICAgYFVuZXhwZWN0ZWQgYmxvY2tpbmcgZmFpbHVyZXM6ICR7SlNPTi5zdHJpbmdpZnkoYmxvY2tpbmdGYWlsdXJlcywgbnVsbCwgMil9YFxuICAgICAgKTtcblxuICAgICAgLy8gU3BlZWQgdGFyZ2V0IG1ldFxuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBkdXJhdGlvbiA8IFBSRV9FWEVDVVRJT05fVElNRU9VVF9NUyxcbiAgICAgICAgYFByZS1leGVjdXRpb24gY2hlY2tzIHRvb2sgJHtkdXJhdGlvbi50b0ZpeGVkKDApfW1zLCBleHBlY3RlZCA8JHtQUkVfRVhFQ1VUSU9OX1RJTUVPVVRfTVN9bXNgXG4gICAgICApO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZShcIlBvc3QtRXhlY3V0aW9uIENoZWNrcyBvbiBSZWFsIEdTRCBDb2RlXCIsICgpID0+IHtcbiAgICB0ZXN0KFwicnVucyBwb3N0LWV4ZWN1dGlvbiBjaGVja3Mgb24gcmVhbCBHU0Qgc291cmNlIGZpbGVzXCIsICgpID0+IHtcbiAgICAgIC8vIFNpbXVsYXRlIGEgY29tcGxldGVkIHRhc2sgdGhhdCBtb2RpZmllZCByZWFsIGZpbGVzXG4gICAgICBjb25zdCBjb21wbGV0ZWRUYXNrID0gY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICB0aXRsZTogXCJVcGRhdGUgZ3NkLWRiIHZhbGlkYXRpb25cIixcbiAgICAgICAgc3RhdHVzOiBcImNvbXBsZXRlXCIsXG4gICAgICAgIGtleV9maWxlczogW1xuICAgICAgICAgIGpvaW4oR1NEX1NSQ19ESVIsIFwiZ3NkLWRiLnRzXCIpLFxuICAgICAgICAgIGpvaW4oR1NEX1NSQ19ESVIsIFwidHlwZXMudHNcIiksXG4gICAgICAgIF0sXG4gICAgICB9KTtcblxuICAgICAgY29uc3Qgc3RhcnQgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHJ1blBvc3RFeGVjdXRpb25DaGVja3MoY29tcGxldGVkVGFzaywgW10sIEdTRF9TUkNfRElSKTtcbiAgICAgIGNvbnN0IGR1cmF0aW9uID0gcGVyZm9ybWFuY2Uubm93KCkgLSBzdGFydDtcblxuICAgICAgLy8gUjAxMjogTm8gYmxvY2tpbmcgZmFpbHVyZXMgKGZhbHNlIHBvc2l0aXZlcykgb24gcHJvZHVjdGlvbiBjb2RlXG4gICAgICBjb25zdCBibG9ja2luZ0ZhaWx1cmVzID0gcmVzdWx0LmNoZWNrcy5maWx0ZXIoKGMpID0+ICFjLnBhc3NlZCAmJiBjLmJsb2NraW5nKTtcbiAgICAgIGFzc2VydC5lcXVhbChcbiAgICAgICAgYmxvY2tpbmdGYWlsdXJlcy5sZW5ndGgsXG4gICAgICAgIDAsXG4gICAgICAgIGBFeHBlY3RlZCB6ZXJvIGJsb2NraW5nIGZhaWx1cmVzLCBnb3Q6ICR7SlNPTi5zdHJpbmdpZnkoYmxvY2tpbmdGYWlsdXJlcywgbnVsbCwgMil9YFxuICAgICAgKTtcblxuICAgICAgLy8gT3ZlcmFsbCBzdGF0dXMgc2hvdWxkIG5vdCBiZSBmYWlsXG4gICAgICBhc3NlcnQubm90RXF1YWwocmVzdWx0LnN0YXR1cywgXCJmYWlsXCIsIFwiUG9zdC1leGVjdXRpb24gY2hlY2tzIHNob3VsZCBub3QgZmFpbCBvbiByZWFsIEdTRCBjb2RlXCIpO1xuXG4gICAgICAvLyBSMDEzOiBTcGVlZCB0YXJnZXQgbWV0XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIGR1cmF0aW9uIDwgUE9TVF9FWEVDVVRJT05fVElNRU9VVF9NUyxcbiAgICAgICAgYFBvc3QtZXhlY3V0aW9uIGNoZWNrcyB0b29rICR7ZHVyYXRpb24udG9GaXhlZCgwKX1tcywgZXhwZWN0ZWQgPCR7UE9TVF9FWEVDVVRJT05fVElNRU9VVF9NU31tc2BcbiAgICAgICk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiYW5hbHl6ZXMgaW1wb3J0cyBpbiByZWFsIFR5cGVTY3JpcHQgZmlsZXNcIiwgKCkgPT4ge1xuICAgICAgLy8gVXNlIGF1dG8tdmVyaWZpY2F0aW9uLnRzIHdoaWNoIGltcG9ydHMgZnJvbSBtdWx0aXBsZSBvdGhlciBHU0QgZmlsZXNcbiAgICAgIGNvbnN0IGNvbXBsZXRlZFRhc2sgPSBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAyXCIsXG4gICAgICAgIHRpdGxlOiBcIlZlcmlmeSBhdXRvLXZlcmlmaWNhdGlvbiBpbXBvcnRzXCIsXG4gICAgICAgIHN0YXR1czogXCJjb21wbGV0ZVwiLFxuICAgICAgICBrZXlfZmlsZXM6IFtqb2luKEdTRF9TUkNfRElSLCBcImF1dG8tdmVyaWZpY2F0aW9uLnRzXCIpXSxcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBzdGFydCA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICAgICAgY29uc3QgcmVzdWx0ID0gcnVuUG9zdEV4ZWN1dGlvbkNoZWNrcyhjb21wbGV0ZWRUYXNrLCBbXSwgR1NEX1NSQ19ESVIpO1xuICAgICAgY29uc3QgZHVyYXRpb24gPSBwZXJmb3JtYW5jZS5ub3coKSAtIHN0YXJ0O1xuXG4gICAgICAvLyBObyBibG9ja2luZyBmYWlsdXJlc1xuICAgICAgY29uc3QgYmxvY2tpbmdGYWlsdXJlcyA9IHJlc3VsdC5jaGVja3MuZmlsdGVyKChjKSA9PiAhYy5wYXNzZWQgJiYgYy5ibG9ja2luZyk7XG4gICAgICBhc3NlcnQuZXF1YWwoXG4gICAgICAgIGJsb2NraW5nRmFpbHVyZXMubGVuZ3RoLFxuICAgICAgICAwLFxuICAgICAgICBgVW5leHBlY3RlZCBibG9ja2luZyBmYWlsdXJlczogJHtKU09OLnN0cmluZ2lmeShibG9ja2luZ0ZhaWx1cmVzLCBudWxsLCAyKX1gXG4gICAgICApO1xuXG4gICAgICAvLyBTcGVlZCB0YXJnZXQgbWV0XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIGR1cmF0aW9uIDwgUE9TVF9FWEVDVVRJT05fVElNRU9VVF9NUyxcbiAgICAgICAgYFBvc3QtZXhlY3V0aW9uIGNoZWNrcyB0b29rICR7ZHVyYXRpb24udG9GaXhlZCgwKX1tcywgZXhwZWN0ZWQgPCR7UE9TVF9FWEVDVVRJT05fVElNRU9VVF9NU31tc2BcbiAgICAgICk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiaGFuZGxlcyBtdWx0aS1maWxlIHRhc2sgd2l0aCBjcm9zcy1maWxlIGRlcGVuZGVuY2llc1wiLCAoKSA9PiB7XG4gICAgICAvLyBUYXNrIHRoYXQgdG91Y2hlZCBtdWx0aXBsZSByZWxhdGVkIGZpbGVzXG4gICAgICBjb25zdCBjb21wbGV0ZWRUYXNrID0gY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwM1wiLFxuICAgICAgICB0aXRsZTogXCJSZWZhY3RvciBzdGF0ZSBtYW5hZ2VtZW50XCIsXG4gICAgICAgIHN0YXR1czogXCJjb21wbGV0ZVwiLFxuICAgICAgICBrZXlfZmlsZXM6IFtcbiAgICAgICAgICBqb2luKEdTRF9TUkNfRElSLCBcInN0YXRlLnRzXCIpLFxuICAgICAgICAgIGpvaW4oR1NEX1NSQ19ESVIsIFwiZ3NkLWRiLnRzXCIpLFxuICAgICAgICAgIGpvaW4oR1NEX1NSQ19ESVIsIFwiY2FjaGUudHNcIiksXG4gICAgICAgIF0sXG4gICAgICB9KTtcblxuICAgICAgY29uc3Qgc3RhcnQgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHJ1blBvc3RFeGVjdXRpb25DaGVja3MoY29tcGxldGVkVGFzaywgW10sIEdTRF9TUkNfRElSKTtcbiAgICAgIGNvbnN0IGR1cmF0aW9uID0gcGVyZm9ybWFuY2Uubm93KCkgLSBzdGFydDtcblxuICAgICAgLy8gTm8gYmxvY2tpbmcgZmFpbHVyZXNcbiAgICAgIGNvbnN0IGJsb2NraW5nRmFpbHVyZXMgPSByZXN1bHQuY2hlY2tzLmZpbHRlcigoYykgPT4gIWMucGFzc2VkICYmIGMuYmxvY2tpbmcpO1xuICAgICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgICBibG9ja2luZ0ZhaWx1cmVzLmxlbmd0aCxcbiAgICAgICAgMCxcbiAgICAgICAgYFVuZXhwZWN0ZWQgYmxvY2tpbmcgZmFpbHVyZXM6ICR7SlNPTi5zdHJpbmdpZnkoYmxvY2tpbmdGYWlsdXJlcywgbnVsbCwgMil9YFxuICAgICAgKTtcblxuICAgICAgLy8gU3BlZWQgdGFyZ2V0IG1ldFxuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBkdXJhdGlvbiA8IFBPU1RfRVhFQ1VUSU9OX1RJTUVPVVRfTVMsXG4gICAgICAgIGBQb3N0LWV4ZWN1dGlvbiBjaGVja3MgdG9vayAke2R1cmF0aW9uLnRvRml4ZWQoMCl9bXMsIGV4cGVjdGVkIDwke1BPU1RfRVhFQ1VUSU9OX1RJTUVPVVRfTVN9bXNgXG4gICAgICApO1xuICAgIH0pO1xuXG4gICAgdGVzdChcImhhbmRsZXMgdGFzayBzZXF1ZW5jZSB3aXRoIHNpZ25hdHVyZSBhbmFseXNpc1wiLCAoKSA9PiB7XG4gICAgICAvLyBTaW11bGF0ZSBjaGVja2luZyBmb3Igc2lnbmF0dXJlIGNvbnNpc3RlbmN5IGFjcm9zcyB0YXNrc1xuICAgICAgY29uc3QgcHJpb3JUYXNrczogVGFza1Jvd1tdID0gW1xuICAgICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgICBzZXF1ZW5jZTogMCxcbiAgICAgICAgICB0aXRsZTogXCJEZWZpbmUgVGFza1JvdyBpbnRlcmZhY2VcIixcbiAgICAgICAgICBzdGF0dXM6IFwiY29tcGxldGVcIixcbiAgICAgICAgICBrZXlfZmlsZXM6IFtqb2luKEdTRF9TUkNfRElSLCBcImdzZC1kYi50c1wiKV0sXG4gICAgICAgIH0pLFxuICAgICAgXTtcblxuICAgICAgY29uc3QgY29tcGxldGVkVGFzayA9IGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDJcIixcbiAgICAgICAgc2VxdWVuY2U6IDEsXG4gICAgICAgIHRpdGxlOiBcIlVzZSBUYXNrUm93IGluIHN0YXRlIG1vZHVsZVwiLFxuICAgICAgICBzdGF0dXM6IFwiY29tcGxldGVcIixcbiAgICAgICAga2V5X2ZpbGVzOiBbam9pbihHU0RfU1JDX0RJUiwgXCJzdGF0ZS50c1wiKV0sXG4gICAgICB9KTtcblxuICAgICAgY29uc3Qgc3RhcnQgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHJ1blBvc3RFeGVjdXRpb25DaGVja3MoY29tcGxldGVkVGFzaywgcHJpb3JUYXNrcywgR1NEX1NSQ19ESVIpO1xuICAgICAgY29uc3QgZHVyYXRpb24gPSBwZXJmb3JtYW5jZS5ub3coKSAtIHN0YXJ0O1xuXG4gICAgICAvLyBObyBibG9ja2luZyBmYWlsdXJlc1xuICAgICAgY29uc3QgYmxvY2tpbmdGYWlsdXJlcyA9IHJlc3VsdC5jaGVja3MuZmlsdGVyKChjKSA9PiAhYy5wYXNzZWQgJiYgYy5ibG9ja2luZyk7XG4gICAgICBhc3NlcnQuZXF1YWwoXG4gICAgICAgIGJsb2NraW5nRmFpbHVyZXMubGVuZ3RoLFxuICAgICAgICAwLFxuICAgICAgICBgVW5leHBlY3RlZCBibG9ja2luZyBmYWlsdXJlczogJHtKU09OLnN0cmluZ2lmeShibG9ja2luZ0ZhaWx1cmVzLCBudWxsLCAyKX1gXG4gICAgICApO1xuXG4gICAgICAvLyBTcGVlZCB0YXJnZXQgbWV0XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIGR1cmF0aW9uIDwgUE9TVF9FWEVDVVRJT05fVElNRU9VVF9NUyxcbiAgICAgICAgYFBvc3QtZXhlY3V0aW9uIGNoZWNrcyB0b29rICR7ZHVyYXRpb24udG9GaXhlZCgwKX1tcywgZXhwZWN0ZWQgPCR7UE9TVF9FWEVDVVRJT05fVElNRU9VVF9NU31tc2BcbiAgICAgICk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKFwiQ29tYmluZWQgUHJlIGFuZCBQb3N0IEV4ZWN1dGlvbiBGbG93XCIsICgpID0+IHtcbiAgICB0ZXN0KFwiZnVsbCB2ZXJpZmljYXRpb24gZmxvdyBvbiByZWFsaXN0aWMgdGFzayBsaWZlY3ljbGVcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgLy8gU2ltdWxhdGUgYSBjb21wbGV0ZSB0YXNrIGxpZmVjeWNsZVxuICAgICAgY29uc3QgdGFza3M6IFRhc2tSb3dbXSA9IFtcbiAgICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgICAgc2VxdWVuY2U6IDAsXG4gICAgICAgICAgdGl0bGU6IFwiSW1wbGVtZW50IGVuaGFuY2VkIHZlcmlmaWNhdGlvblwiLFxuICAgICAgICAgIHN0YXR1czogXCJwZW5kaW5nXCIsXG4gICAgICAgICAgZGVzY3JpcHRpb246IGBcbiMjIFN0ZXBzXG4xLiBVcGRhdGUgcHJlLWV4ZWN1dGlvbi1jaGVja3MudHMgd2l0aCBuZXcgdmFsaWRhdGlvblxuMi4gVXBkYXRlIHBvc3QtZXhlY3V0aW9uLWNoZWNrcy50cyB3aXRoIHNpZ25hdHVyZSBhbmFseXNpc1xuMy4gQWRkIGludGVncmF0aW9uIHRlc3RzXG5cblxcYFxcYFxcYHR5cGVzY3JpcHRcbmltcG9ydCB7IHJ1blByZUV4ZWN1dGlvbkNoZWNrcyB9IGZyb20gXCIuL3ByZS1leGVjdXRpb24tY2hlY2tzLnRzXCI7XG5pbXBvcnQgeyBydW5Qb3N0RXhlY3V0aW9uQ2hlY2tzIH0gZnJvbSBcIi4vcG9zdC1leGVjdXRpb24tY2hlY2tzLnRzXCI7XG5cXGBcXGBcXGBcbiAgICAgICAgICBgLnRyaW0oKSxcbiAgICAgICAgICBmaWxlczogW1xuICAgICAgICAgICAgam9pbihHU0RfU1JDX0RJUiwgXCJwcmUtZXhlY3V0aW9uLWNoZWNrcy50c1wiKSxcbiAgICAgICAgICAgIGpvaW4oR1NEX1NSQ19ESVIsIFwicG9zdC1leGVjdXRpb24tY2hlY2tzLnRzXCIpLFxuICAgICAgICAgIF0sXG4gICAgICAgICAgaW5wdXRzOiBbXG4gICAgICAgICAgICBqb2luKEdTRF9TUkNfRElSLCBcInR5cGVzLnRzXCIpLFxuICAgICAgICAgICAgam9pbihHU0RfU1JDX0RJUiwgXCJnc2QtZGIudHNcIiksXG4gICAgICAgICAgXSxcbiAgICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtcbiAgICAgICAgICAgIGpvaW4oR1NEX1NSQ19ESVIsIFwidGVzdHMvZW5oYW5jZWQtdmVyaWZpY2F0aW9uLWludGVncmF0aW9uLnRlc3QudHNcIiksXG4gICAgICAgICAgXSxcbiAgICAgICAgfSksXG4gICAgICBdO1xuXG4gICAgICAvLyBSdW4gcHJlLWV4ZWN1dGlvbiBjaGVja3NcbiAgICAgIGNvbnN0IHByZVN0YXJ0ID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gICAgICBjb25zdCBwcmVSZXN1bHQgPSBhd2FpdCBydW5QcmVFeGVjdXRpb25DaGVja3ModGFza3MsIEdTRF9TUkNfRElSKTtcbiAgICAgIGNvbnN0IHByZUR1cmF0aW9uID0gcGVyZm9ybWFuY2Uubm93KCkgLSBwcmVTdGFydDtcblxuICAgICAgLy8gVmVyaWZ5IHByZS1leGVjdXRpb24gcmVzdWx0c1xuICAgICAgY29uc3QgcHJlQmxvY2tpbmdGYWlsdXJlcyA9IHByZVJlc3VsdC5jaGVja3MuZmlsdGVyKChjKSA9PiAhYy5wYXNzZWQgJiYgYy5ibG9ja2luZyk7XG4gICAgICBhc3NlcnQuZXF1YWwoXG4gICAgICAgIHByZUJsb2NraW5nRmFpbHVyZXMubGVuZ3RoLFxuICAgICAgICAwLFxuICAgICAgICBgUHJlLWV4ZWN1dGlvbiBoYWQgYmxvY2tpbmcgZmFpbHVyZXM6ICR7SlNPTi5zdHJpbmdpZnkocHJlQmxvY2tpbmdGYWlsdXJlcywgbnVsbCwgMil9YFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgcHJlRHVyYXRpb24gPCBQUkVfRVhFQ1VUSU9OX1RJTUVPVVRfTVMsXG4gICAgICAgIGBQcmUtZXhlY3V0aW9uIHRvb2sgJHtwcmVEdXJhdGlvbi50b0ZpeGVkKDApfW1zLCBleHBlY3RlZCA8JHtQUkVfRVhFQ1VUSU9OX1RJTUVPVVRfTVN9bXNgXG4gICAgICApO1xuXG4gICAgICAvLyBUYXNrIGFmdGVyIGV4ZWN1dGlvbiAoc2ltdWxhdGVkIGNvbXBsZXRpb24pXG4gICAgICBjb25zdCBjb21wbGV0ZWRUYXNrID0gY3JlYXRlVGFzayh7XG4gICAgICAgIC4uLnRhc2tzWzBdLFxuICAgICAgICBzdGF0dXM6IFwiY29tcGxldGVcIixcbiAgICAgICAga2V5X2ZpbGVzOiB0YXNrc1swXS5maWxlcyxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBSdW4gcG9zdC1leGVjdXRpb24gY2hlY2tzXG4gICAgICBjb25zdCBwb3N0U3RhcnQgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgICAgIGNvbnN0IHBvc3RSZXN1bHQgPSBydW5Qb3N0RXhlY3V0aW9uQ2hlY2tzKGNvbXBsZXRlZFRhc2ssIFtdLCBHU0RfU1JDX0RJUik7XG4gICAgICBjb25zdCBwb3N0RHVyYXRpb24gPSBwZXJmb3JtYW5jZS5ub3coKSAtIHBvc3RTdGFydDtcblxuICAgICAgLy8gVmVyaWZ5IHBvc3QtZXhlY3V0aW9uIHJlc3VsdHNcbiAgICAgIGNvbnN0IHBvc3RCbG9ja2luZ0ZhaWx1cmVzID0gcG9zdFJlc3VsdC5jaGVja3MuZmlsdGVyKChjKSA9PiAhYy5wYXNzZWQgJiYgYy5ibG9ja2luZyk7XG4gICAgICBhc3NlcnQuZXF1YWwoXG4gICAgICAgIHBvc3RCbG9ja2luZ0ZhaWx1cmVzLmxlbmd0aCxcbiAgICAgICAgMCxcbiAgICAgICAgYFBvc3QtZXhlY3V0aW9uIGhhZCBibG9ja2luZyBmYWlsdXJlczogJHtKU09OLnN0cmluZ2lmeShwb3N0QmxvY2tpbmdGYWlsdXJlcywgbnVsbCwgMil9YFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgcG9zdER1cmF0aW9uIDwgUE9TVF9FWEVDVVRJT05fVElNRU9VVF9NUyxcbiAgICAgICAgYFBvc3QtZXhlY3V0aW9uIHRvb2sgJHtwb3N0RHVyYXRpb24udG9GaXhlZCgwKX1tcywgZXhwZWN0ZWQgPCR7UE9TVF9FWEVDVVRJT05fVElNRU9VVF9NU31tc2BcbiAgICAgICk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiaGFuZGxlcyBsYXJnZSBudW1iZXIgb2YgZmlsZXMgd2l0aG91dCB0aW1lb3V0XCIsICgpID0+IHtcbiAgICAgIC8vIFVzZSBhbGwgYXZhaWxhYmxlIEdTRCBzb3VyY2UgZmlsZXMgdG8gc3RyZXNzIHRlc3RcbiAgICAgIGNvbnN0IGFsbEdzZEZpbGVzID0gUkVBTF9HU0RfRklMRVMubWFwKChmKSA9PiBqb2luKEdTRF9TUkNfRElSLCBmKSk7XG5cbiAgICAgIGNvbnN0IHRhc2sgPSBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgIHRpdGxlOiBcIkxhcmdlIHJlZmFjdG9yIHRvdWNoaW5nIG1hbnkgZmlsZXNcIixcbiAgICAgICAgc3RhdHVzOiBcImNvbXBsZXRlXCIsXG4gICAgICAgIGtleV9maWxlczogYWxsR3NkRmlsZXMsXG4gICAgICAgIGZpbGVzOiBhbGxHc2RGaWxlcyxcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBzdGFydCA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICAgICAgY29uc3QgcmVzdWx0ID0gcnVuUG9zdEV4ZWN1dGlvbkNoZWNrcyh0YXNrLCBbXSwgR1NEX1NSQ19ESVIpO1xuICAgICAgY29uc3QgZHVyYXRpb24gPSBwZXJmb3JtYW5jZS5ub3coKSAtIHN0YXJ0O1xuXG4gICAgICAvLyBObyBibG9ja2luZyBmYWlsdXJlc1xuICAgICAgY29uc3QgYmxvY2tpbmdGYWlsdXJlcyA9IHJlc3VsdC5jaGVja3MuZmlsdGVyKChjKSA9PiAhYy5wYXNzZWQgJiYgYy5ibG9ja2luZyk7XG4gICAgICBhc3NlcnQuZXF1YWwoXG4gICAgICAgIGJsb2NraW5nRmFpbHVyZXMubGVuZ3RoLFxuICAgICAgICAwLFxuICAgICAgICBgVW5leHBlY3RlZCBibG9ja2luZyBmYWlsdXJlczogJHtKU09OLnN0cmluZ2lmeShibG9ja2luZ0ZhaWx1cmVzLCBudWxsLCAyKX1gXG4gICAgICApO1xuXG4gICAgICAvLyBTaG91bGQgc3RpbGwgYmUgZmFzdCBldmVuIHdpdGggbWFueSBmaWxlc1xuICAgICAgLy8gQWxsb3cgc2xpZ2h0bHkgbW9yZSB0aW1lIGZvciBtdWx0aS1maWxlIGFuYWx5c2lzIGJ1dCBzdGlsbCB3aXRoaW4gdGFyZ2V0XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIGR1cmF0aW9uIDwgUE9TVF9FWEVDVVRJT05fVElNRU9VVF9NUyAqIDIsIC8vIEFsbG93IDJ4IGZvciBzdHJlc3MgdGVzdFxuICAgICAgICBgTXVsdGktZmlsZSBwb3N0LWV4ZWN1dGlvbiB0b29rICR7ZHVyYXRpb24udG9GaXhlZCgwKX1tcywgZXhwZWN0ZWQgPCR7UE9TVF9FWEVDVVRJT05fVElNRU9VVF9NUyAqIDJ9bXNgXG4gICAgICApO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZShcIldhcm5pbmcgUXVhbGl0eVwiLCAoKSA9PiB7XG4gICAgdGVzdChcIndhcm5pbmdzIG9uIHJlYWwgY29kZSBhcmUgYWN0aW9uYWJsZSwgbm90IHNwdXJpb3VzXCIsICgpID0+IHtcbiAgICAgIC8vIFJ1biBjaGVja3Mgb24gd2VsbC1mb3JtZWQgcHJvZHVjdGlvbiBjb2RlXG4gICAgICBjb25zdCB0YXNrID0gY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICB0aXRsZTogXCJSZXZpZXcgY29kZSBxdWFsaXR5XCIsXG4gICAgICAgIHN0YXR1czogXCJjb21wbGV0ZVwiLFxuICAgICAgICBrZXlfZmlsZXM6IFtcbiAgICAgICAgICBqb2luKEdTRF9TUkNfRElSLCBcInByZS1leGVjdXRpb24tY2hlY2tzLnRzXCIpLFxuICAgICAgICAgIGpvaW4oR1NEX1NSQ19ESVIsIFwicG9zdC1leGVjdXRpb24tY2hlY2tzLnRzXCIpLFxuICAgICAgICBdLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IHJ1blBvc3RFeGVjdXRpb25DaGVja3ModGFzaywgW10sIEdTRF9TUkNfRElSKTtcblxuICAgICAgLy8gRXh0cmFjdCB3YXJuaW5ncyAoZWl0aGVyIG5vbi1wYXNzZWQgbm9uLWJsb2NraW5nLCBvciBwYXNzZWQgd2l0aCB3YXJuaW5nIG1lc3NhZ2VzKVxuICAgICAgY29uc3Qgd2FybmluZ3MgPSByZXN1bHQuY2hlY2tzLmZpbHRlcihcbiAgICAgICAgKGMpID0+ICghYy5wYXNzZWQgJiYgIWMuYmxvY2tpbmcpIHx8IChjLnBhc3NlZCAmJiBjLm1lc3NhZ2U/LnN0YXJ0c1dpdGgoXCJXYXJuaW5nOlwiKSlcbiAgICAgICk7XG5cbiAgICAgIC8vIFdhcm5pbmdzIGFyZSBhY2NlcHRhYmxlIGJ1dCBzaG91bGQgYmUgZmV3IG9uIHdlbGwtbWFpbnRhaW5lZCBjb2RlXG4gICAgICAvLyBJZiB3ZSBnZXQgbWFueSB3YXJuaW5ncywgaXQgc3VnZ2VzdHMgdGhlIGNoZWNrcyBhcmUgdG9vIGFnZ3Jlc3NpdmVcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgd2FybmluZ3MubGVuZ3RoIDw9IDEwLFxuICAgICAgICBgVG9vIG1hbnkgd2FybmluZ3MgKCR7d2FybmluZ3MubGVuZ3RofSkgc3VnZ2VzdHMgb3Zlcmx5IGFnZ3Jlc3NpdmUgY2hlY2tzOiAke0pTT04uc3RyaW5naWZ5KHdhcm5pbmdzLCBudWxsLCAyKX1gXG4gICAgICApO1xuXG4gICAgICAvLyBFYWNoIHdhcm5pbmcgc2hvdWxkIGhhdmUgYSBjbGVhciBtZXNzYWdlXG4gICAgICBmb3IgKGNvbnN0IHdhcm5pbmcgb2Ygd2FybmluZ3MpIHtcbiAgICAgICAgYXNzZXJ0Lm9rKHdhcm5pbmcuY2F0ZWdvcnksIFwiV2FybmluZyBtaXNzaW5nIGNhdGVnb3J5XCIpO1xuICAgICAgICBhc3NlcnQub2sod2FybmluZy5tZXNzYWdlLCBcIldhcm5pbmcgbWlzc2luZyBtZXNzYWdlXCIpO1xuICAgICAgICBhc3NlcnQub2soXG4gICAgICAgICAgd2FybmluZy5tZXNzYWdlLmxlbmd0aCA+IDEwLFxuICAgICAgICAgIGBXYXJuaW5nIG1lc3NhZ2UgdG9vIHNob3J0IHRvIGJlIGFjdGlvbmFibGU6IFwiJHt3YXJuaW5nLm1lc3NhZ2V9XCJgXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFZQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxNQUFNLGVBQWU7QUFDOUIsU0FBUyxxQkFBcUI7QUFFOUI7QUFBQSxFQUNFO0FBQUEsT0FFSztBQUNQO0FBQUEsRUFDRTtBQUFBLE9BRUs7QUFLUCxNQUFNLGFBQWEsY0FBYyxZQUFZLEdBQUc7QUFDaEQsTUFBTSxZQUFZLFFBQVEsVUFBVTtBQUdwQyxNQUFNLGNBQWMsS0FBSyxXQUFXLElBQUk7QUFHeEMsTUFBTSwyQkFBMkI7QUFDakMsTUFBTSw0QkFBNEI7QUFPbEMsU0FBUyxXQUFXLFlBQThCLENBQUMsR0FBWTtBQUM3RCxTQUFPO0FBQUEsSUFDTCxjQUFjO0FBQUEsSUFDZCxVQUFVO0FBQUEsSUFDVixJQUFJLFVBQVUsTUFBTTtBQUFBLElBQ3BCLE9BQU8sVUFBVSxTQUFTO0FBQUEsSUFDMUIsUUFBUSxVQUFVLFVBQVU7QUFBQSxJQUM1QixXQUFXO0FBQUEsSUFDWCxXQUFXO0FBQUEsSUFDWCxxQkFBcUI7QUFBQSxJQUNyQixVQUFVO0FBQUEsSUFDVixjQUFjLFVBQVUsV0FBVyxjQUFhLG9CQUFJLEtBQUssR0FBRSxZ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
