import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { symlinkSync, realpathSync } from "node:fs";
import { _getAdapter, closeDatabase } from "../../../src/resources/extensions/gsd/gsd-db.js";
import { _buildImportCandidates, registerWorkflowTools, WORKFLOW_TOOL_NAMES, validateProjectDir } from "./workflow-tools.js";
function makeTmpBase() {
  const base = join(tmpdir(), `gsd-mcp-workflow-${randomUUID()}`);
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
function writeWriteGateSnapshot(base, snapshot) {
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "runtime", "write-gate-state.json"),
    JSON.stringify(
      {
        verifiedDepthMilestones: snapshot.verifiedDepthMilestones ?? [],
        activeQueuePhase: snapshot.activeQueuePhase ?? false,
        pendingGateId: snapshot.pendingGateId ?? null
      },
      null,
      2
    ),
    "utf-8"
  );
}
function makeMockServer() {
  const tools = [];
  return {
    tools,
    tool(name, description, params, handler) {
      tools.push({ name, description, params, handler });
    }
  };
}
function assertToolError(result, expected) {
  const record = result;
  assert.equal(record.isError, true, "tool result should be marked as an MCP error");
  const text = record.content?.[0]?.text;
  assert.equal(typeof text, "string", "tool error result should contain text");
  if (expected instanceof RegExp) {
    assert.match(text, expected);
  } else {
    assert.ok(text.includes(expected), `error should mention ${expected}, got: ${text}`);
  }
  return text;
}
function cacheBustedWorkflowToolsImport(tag) {
  const extension = import.meta.url.includes("/dist-test/") ? "js" : "ts";
  return `./workflow-tools.${extension}?${tag}=${randomUUID()}`;
}
describe("workflow MCP tools", () => {
  it("registers the full headless-safe workflow tool surface", () => {
    const server = makeMockServer();
    registerWorkflowTools(server);
    assert.equal(server.tools.length, WORKFLOW_TOOL_NAMES.length);
    assert.deepEqual(server.tools.map((t) => t.name), [...WORKFLOW_TOOL_NAMES]);
  });
  it("registers task reopen in the workflow MCP tool surface", () => {
    const server = makeMockServer();
    registerWorkflowTools(server);
    const toolNames = server.tools.map((t) => t.name);
    assert.ok(toolNames.includes("gsd_task_reopen"));
    assert.ok(toolNames.includes("gsd_reopen_task"));
    const taskReopen = server.tools.find((t) => t.name === "gsd_task_reopen");
    assert.ok(taskReopen);
    assert.ok("milestoneId" in taskReopen.params);
    assert.ok("sliceId" in taskReopen.params);
    assert.ok("taskId" in taskReopen.params);
    assert.ok("reason" in taskReopen.params);
  });
  it("prefers source TypeScript before compiled dist fallbacks", () => {
    assert.deepEqual(
      _buildImportCandidates("../../../src/resources/extensions/gsd/tools/workflow-tool-executors.js"),
      [
        "../../../src/resources/extensions/gsd/tools/workflow-tool-executors.ts",
        "../../../src/resources/extensions/gsd/tools/workflow-tool-executors.js",
        "../../../dist/resources/extensions/gsd/tools/workflow-tool-executors.ts",
        "../../../dist/resources/extensions/gsd/tools/workflow-tool-executors.js"
      ]
    );
  });
  it("gsd_summary_save writes artifact through the shared executor", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server);
      const tool = server.tools.find((t) => t.name === "gsd_summary_save");
      assert.ok(tool, "summary tool should be registered");
      const originalCwd = process.cwd();
      const result = await tool.handler({
        projectDir: base,
        milestone_id: "M001",
        slice_id: "S01",
        artifact_type: "SUMMARY",
        content: "# Summary\n\nHello"
      });
      const text = result.content[0].text;
      assert.match(text, /Saved SUMMARY artifact/);
      assert.equal(process.cwd(), originalCwd, "workflow MCP tools should not mutate process.cwd");
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md")),
        "summary file should exist on disk"
      );
    } finally {
      cleanup(base);
    }
  });
  it("gsd_exec runs by default, preserves cwd, and returns structured metadata", async () => {
    const base = makeTmpBase();
    const originalCwd = process.cwd();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server);
      const tool = server.tools.find((t) => t.name === "gsd_exec");
      assert.ok(tool, "exec tool should be registered");
      const result = await tool.handler({
        projectDir: base,
        runtime: "node",
        script: "console.log(process.cwd()); console.log('context mode default on');",
        purpose: "default-on smoke"
      });
      const record = result;
      assert.equal(record.isError, false);
      assert.match(record.content[0].text, /context mode default on/);
      assert.equal(record.structuredContent.operation, "gsd_exec");
      assert.equal(record.structuredContent.runtime, "node");
      assert.ok(existsSync(record.structuredContent.stdout_path), "stdout should be persisted");
      assert.equal(process.cwd(), originalCwd, "gsd_exec must not mutate process.cwd");
      assert.match(
        readFileSync(record.structuredContent.stdout_path, "utf-8"),
        new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        "script should run relative to the requested projectDir"
      );
    } finally {
      cleanup(base);
    }
  });
  it("gsd_exec returns an MCP error when context mode is disabled", async () => {
    const base = makeTmpBase();
    try {
      writeFileSync(
        join(base, ".gsd", "PREFERENCES.md"),
        "---\ncontext_mode:\n  enabled: false\n---\n",
        "utf-8"
      );
      const server = makeMockServer();
      registerWorkflowTools(server);
      const tool = server.tools.find((t) => t.name === "gsd_exec");
      assert.ok(tool, "exec tool should be registered");
      const result = await tool.handler({
        projectDir: base,
        runtime: "bash",
        script: "echo should-not-run"
      });
      assertToolError(result, /context_mode\.enabled: false/);
      assert.equal(result.structuredContent.error, "context_mode_disabled");
    } finally {
      cleanup(base);
    }
  });
  it("gsd_exec is blocked by the MCP discussion-gate write gate", async () => {
    const base = makeTmpBase();
    try {
      writeWriteGateSnapshot(base, { pendingGateId: "depth_verification_M001_confirm" });
      const server = makeMockServer();
      registerWorkflowTools(server);
      const tool = server.tools.find((t) => t.name === "gsd_exec");
      assert.ok(tool, "exec tool should be registered");
      const result = await tool.handler({
        projectDir: base,
        runtime: "bash",
        script: "echo should-not-run"
      });
      assertToolError(result, /Discussion gate .* has not been confirmed/);
    } finally {
      cleanup(base);
    }
  });
  it("gsd_exec_search finds a prior gsd_exec run", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server);
      const execTool = server.tools.find((t) => t.name === "gsd_exec");
      const searchTool = server.tools.find((t) => t.name === "gsd_exec_search");
      assert.ok(execTool, "exec tool should be registered");
      assert.ok(searchTool, "exec search tool should be registered");
      await execTool.handler({
        projectDir: base,
        runtime: "bash",
        script: "printf 'needle-output\\n'",
        purpose: "find-me-later"
      });
      const result = await searchTool.handler({
        projectDir: base,
        query: "find-me"
      });
      assert.match(result.content[0].text, /find-me-later/);
      assert.equal(result.structuredContent.operation, "gsd_exec_search");
      assert.equal(result.structuredContent.matches, 1);
      assert.match(result.structuredContent.results[0].stdout_path, /\.gsd[\\/]exec[\\/].*\.stdout$/);
    } finally {
      cleanup(base);
    }
  });
  it("gsd_exec_search returns an MCP error when context mode is disabled", async () => {
    const base = makeTmpBase();
    try {
      writeFileSync(
        join(base, ".gsd", "PREFERENCES.md"),
        "---\ncontext_mode:\n  enabled: false\n---\n",
        "utf-8"
      );
      const server = makeMockServer();
      registerWorkflowTools(server);
      const tool = server.tools.find((t) => t.name === "gsd_exec_search");
      assert.ok(tool, "exec search tool should be registered");
      const result = await tool.handler({ projectDir: base, query: "anything" });
      assertToolError(result, /context_mode\.enabled: false/);
      assert.equal(result.structuredContent.error, "context_mode_disabled");
    } finally {
      cleanup(base);
    }
  });
  it("gsd_resume reads the context snapshot", async () => {
    const base = makeTmpBase();
    try {
      writeFileSync(
        join(base, ".gsd", "last-snapshot.md"),
        "# GSD context snapshot\n\nResume from here.\n",
        "utf-8"
      );
      const server = makeMockServer();
      registerWorkflowTools(server);
      const tool = server.tools.find((t) => t.name === "gsd_resume");
      assert.ok(tool, "resume tool should be registered");
      const result = await tool.handler({ projectDir: base });
      assert.match(result.content[0].text, /Resume from here/);
      assert.deepEqual(result.structuredContent, {
        operation: "gsd_resume",
        found: true,
        bytes: Buffer.byteLength("# GSD context snapshot\n\nResume from here.\n", "utf-8")
      });
    } finally {
      cleanup(base);
    }
  });
  it("gsd_resume returns an MCP error when context mode is disabled", async () => {
    const base = makeTmpBase();
    try {
      writeFileSync(
        join(base, ".gsd", "PREFERENCES.md"),
        "---\ncontext_mode:\n  enabled: false\n---\n",
        "utf-8"
      );
      writeFileSync(join(base, ".gsd", "last-snapshot.md"), "# GSD context snapshot\n\nHidden.\n", "utf-8");
      const server = makeMockServer();
      registerWorkflowTools(server);
      const tool = server.tools.find((t) => t.name === "gsd_resume");
      assert.ok(tool, "resume tool should be registered");
      const result = await tool.handler({ projectDir: base });
      assertToolError(result, /context_mode\.enabled: false/);
      assert.equal(result.structuredContent.error, "context_mode_disabled");
    } finally {
      cleanup(base);
    }
  });
  it("gsd_summary_save supports root-level PROJECT artifacts without milestone_id", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server);
      const tool = server.tools.find((t) => t.name === "gsd_summary_save");
      assert.ok(tool, "summary tool should be registered");
      const milestoneParam = tool.params.milestone_id;
      assert.equal(
        milestoneParam.isOptional?.(),
        true,
        "workflow MCP schema must advertise milestone_id as optional for root artifacts"
      );
      const projectFixture = [
        "# Project",
        "",
        "Root artifact",
        "",
        "## Milestone Sequence",
        "",
        "- [ ] M001: Foundation - Establish the first runnable slice.",
        ""
      ].join("\n");
      const result = await tool.handler({
        projectDir: base,
        artifact_type: "PROJECT",
        content: projectFixture
      });
      const text = result.content[0].text;
      assert.match(text, /Saved PROJECT artifact/);
      assert.ok(
        existsSync(join(base, ".gsd", "PROJECT.md")),
        "root project artifact should exist on disk"
      );
      assert.equal(
        readFileSync(join(base, ".gsd", "PROJECT.md"), "utf-8"),
        projectFixture
      );
    } finally {
      cleanup(base);
    }
  });
  it("gsd_summary_save rejects milestone-scoped artifacts without milestone_id", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server);
      const tool = server.tools.find((t) => t.name === "gsd_summary_save");
      assert.ok(tool, "summary tool should be registered");
      const result = await tool.handler({
        projectDir: base,
        artifact_type: "SUMMARY",
        content: "# Summary\n"
      });
      const text = result.content?.[0]?.text;
      assert.match(
        text,
        /milestone_id is required for milestone-scoped artifact types/
      );
    } finally {
      cleanup(base);
    }
  });
  it("gsd_summary_save renders root REQUIREMENTS from DB rows, not provided markdown", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server);
      const requirementTool = server.tools.find((t) => t.name === "gsd_requirement_save");
      const summaryTool = server.tools.find((t) => t.name === "gsd_summary_save");
      assert.ok(requirementTool, "requirement tool should be registered");
      assert.ok(summaryTool, "summary tool should be registered");
      await requirementTool.handler({
        projectDir: base,
        class: "primary-user-loop",
        description: "MCP user can add a task",
        why: "Core loop",
        source: "user",
        status: "active",
        primary_owner: "M001/none yet",
        supporting_slices: "none",
        validation: "unmapped"
      });
      const result = await summaryTool.handler({
        projectDir: base,
        artifact_type: "REQUIREMENTS",
        content: "# Requirements\n\n## Active\n\n### R999 \u2014 Wrong markdown source\n\n- Description: This content must not become canonical.\n"
      });
      const text = result.content[0].text;
      assert.match(text, /Saved REQUIREMENTS artifact/);
      const requirementsPath = join(base, ".gsd", "REQUIREMENTS.md");
      const markdown = readFileSync(requirementsPath, "utf-8");
      assert.match(markdown, /MCP user can add a task/);
      assert.doesNotMatch(markdown, /R999|Wrong markdown source|This content must not become canonical/);
      const row = _getAdapter().prepare("SELECT id, description FROM requirements WHERE description = ?").get("MCP user can add a task");
      assert.ok(row, "requirement row should remain the canonical source");
      const artifact = _getAdapter().prepare("SELECT full_content FROM artifacts WHERE path = ?").get("REQUIREMENTS.md");
      assert.equal(artifact?.full_content, markdown);
    } finally {
      cleanup(base);
    }
  });
  it("rejects workflow tool calls outside the configured project root", async () => {
    const base = makeTmpBase();
    const otherBase = makeTmpBase();
    const prevRoot = process.env.GSD_WORKFLOW_PROJECT_ROOT;
    try {
      process.env.GSD_WORKFLOW_PROJECT_ROOT = base;
      const server = makeMockServer();
      registerWorkflowTools(server);
      const tool = server.tools.find((t) => t.name === "gsd_summary_save");
      assert.ok(tool, "summary tool should be registered");
      const result = await tool.handler({
        projectDir: otherBase,
        milestone_id: "M001",
        artifact_type: "SUMMARY",
        content: "# Summary"
      });
      assertToolError(result, /configured workflow project root/);
    } finally {
      if (prevRoot === void 0) {
        delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
      } else {
        process.env.GSD_WORKFLOW_PROJECT_ROOT = prevRoot;
      }
      cleanup(base);
      cleanup(otherBase);
    }
  });
  it("rejects non-file executor module URLs", async () => {
    const base = makeTmpBase();
    const prevModule = process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
    const prevRoot = process.env.GSD_WORKFLOW_PROJECT_ROOT;
    try {
      process.env.GSD_WORKFLOW_PROJECT_ROOT = base;
      process.env.GSD_WORKFLOW_EXECUTORS_MODULE = "data:text/javascript,export default {}";
      const { registerWorkflowTools: freshRegisterWorkflowTools } = await import(cacheBustedWorkflowToolsImport("bad-module"));
      const server = makeMockServer();
      freshRegisterWorkflowTools(server);
      const tool = server.tools.find((t) => t.name === "gsd_summary_save");
      assert.ok(tool, "summary tool should be registered");
      const result = await tool.handler({
        projectDir: base,
        milestone_id: "M001",
        artifact_type: "SUMMARY",
        content: "# Summary"
      });
      assertToolError(result, /only supports file: URLs or filesystem paths/);
    } finally {
      if (prevModule === void 0) {
        delete process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
      } else {
        process.env.GSD_WORKFLOW_EXECUTORS_MODULE = prevModule;
      }
      if (prevRoot === void 0) {
        delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
      } else {
        process.env.GSD_WORKFLOW_PROJECT_ROOT = prevRoot;
      }
      cleanup(base);
    }
  });
  it("blocks workflow mutation tools while a discussion gate is pending", async () => {
    const base = makeTmpBase();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
      writeFileSync(
        join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
        "# S01\n\n- [ ] **T01: Demo** `est:5m`\n"
      );
      writeWriteGateSnapshot(base, { pendingGateId: "depth_verification_M001_confirm" });
      const server = makeMockServer();
      registerWorkflowTools(server);
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      assert.ok(taskTool, "task tool should be registered");
      const result = await taskTool.handler({
        projectDir: base,
        taskId: "T01",
        sliceId: "S01",
        milestoneId: "M001",
        oneLiner: "Completed task",
        narrative: "Did the work",
        verification: "npm test"
      });
      assertToolError(result, /Discussion gate .* has not been confirmed/);
    } finally {
      cleanup(base);
    }
  });
  it("blocks workflow mutation tools during queue mode", async () => {
    const base = makeTmpBase();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
      writeFileSync(
        join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
        "# S01\n\n- [ ] **T01: Demo** `est:5m`\n"
      );
      writeWriteGateSnapshot(base, { activeQueuePhase: true });
      const server = makeMockServer();
      registerWorkflowTools(server);
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      assert.ok(taskTool, "task tool should be registered");
      const result = await taskTool.handler({
        projectDir: base,
        taskId: "T01",
        sliceId: "S01",
        milestoneId: "M001",
        oneLiner: "Completed task",
        narrative: "Did the work",
        verification: "npm test"
      });
      assertToolError(result, /planning tool .* not executes work|Cannot gsd_task_complete|Unknown tools are not permitted during queue mode/);
    } finally {
      cleanup(base);
    }
  });
  it("gsd_task_complete and gsd_milestone_status work end-to-end", async () => {
    const base = makeTmpBase();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
      writeFileSync(
        join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
        "# S01\n\n- [ ] **T01: Demo** `est:5m`\n"
      );
      const server = makeMockServer();
      registerWorkflowTools(server);
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      const statusTool = server.tools.find((t) => t.name === "gsd_milestone_status");
      assert.ok(taskTool, "task tool should be registered");
      assert.ok(statusTool, "status tool should be registered");
      const taskResult = await taskTool.handler({
        projectDir: base,
        taskId: "T01",
        sliceId: "S01",
        milestoneId: "M001",
        oneLiner: "Completed task",
        narrative: "Did the work",
        verification: "npm test"
      });
      assert.match(taskResult.content[0].text, /Completed task T01/);
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md")),
        "task summary should be written to disk"
      );
      const statusResult = await statusTool.handler({
        projectDir: base,
        milestoneId: "M001"
      });
      const parsed = JSON.parse(statusResult.content[0].text);
      assert.equal(parsed.milestoneId, "M001");
      assert.equal(parsed.sliceCount, 1);
      assert.equal(parsed.slices[0].id, "S01");
    } finally {
      cleanup(base);
    }
  });
  it("#4477 gsd_task_complete forwards every schema field to the executor (regression for destructure-rebuild bug class)", async () => {
    const base = makeTmpBase();
    const capturePath = join(base, "captured-args.json");
    const mockModulePath = join(base, "mock-executors.mjs");
    const prevModule = process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
    const prevCapture = process.env.GSD_TEST_TASK_COMPLETE_CAPTURE_PATH;
    try {
      const mockSource = `
import { writeFileSync } from "node:fs";

const noop = async () => ({ content: [{ type: "text", text: "noop" }] });

export const SUPPORTED_SUMMARY_ARTIFACT_TYPES = ["SUMMARY", "UAT", "CONTEXT", "PLAN"];
export const executeMilestoneStatus = noop;
export const executePlanMilestone = noop;
export const executePlanSlice = noop;
export const executeReplanSlice = noop;
export const executeSliceComplete = noop;
export const executeCompleteMilestone = noop;
export const executeValidateMilestone = noop;
export const executeReassessRoadmap = noop;
export const executeSaveGateResult = noop;
export const executeSummarySave = noop;
export const executeTaskReopen = noop;
export const executeSliceReopen = noop;
export const executeMilestoneReopen = noop;

export const executeTaskComplete = async (params, projectDir) => {
  const capturePath = process.env.GSD_TEST_TASK_COMPLETE_CAPTURE_PATH;
  if (capturePath) {
    writeFileSync(capturePath, JSON.stringify({ params, projectDir }, null, 2));
  }
  return {
    content: [{ type: "text", text: "mock task complete" }],
    details: { taskId: params.taskId },
  };
};
`;
      writeFileSync(mockModulePath, mockSource, "utf-8");
      process.env.GSD_WORKFLOW_EXECUTORS_MODULE = mockModulePath;
      process.env.GSD_TEST_TASK_COMPLETE_CAPTURE_PATH = capturePath;
      const { registerWorkflowTools: freshRegisterWorkflowTools } = await import(cacheBustedWorkflowToolsImport("escalation-test"));
      const server = makeMockServer();
      freshRegisterWorkflowTools(server);
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      assert.ok(taskTool, "task tool should be registered");
      const escalationPayload = {
        question: "Should the auth flow use OAuth or PAT?",
        options: [
          { id: "A", label: "OAuth", tradeoffs: "Best UX; requires more setup." },
          { id: "B", label: "PAT", tradeoffs: "Simpler; weaker rotation story." }
        ],
        recommendation: "A",
        recommendationRationale: "Initial requirement implied multi-user; OAuth fits better.",
        continueWithDefault: true
      };
      await taskTool.handler({
        projectDir: base,
        taskId: "T01",
        sliceId: "S01",
        milestoneId: "M001",
        oneLiner: "Completed task with escalation",
        narrative: "Did the work but flagged an ambiguity",
        verification: "npm test",
        escalation: escalationPayload,
        verificationEvidence: [
          { command: "npm test", exitCode: 0, verdict: "pass", durationMs: 1234 }
        ]
      });
      assert.ok(existsSync(capturePath), "mock executor should have written captured args to disk");
      const captured = JSON.parse(readFileSync(capturePath, "utf-8"));
      assert.equal(captured.projectDir, realpathSync(base), "projectDir should be passed as second arg");
      assert.deepEqual(
        captured.params.escalation,
        escalationPayload,
        "escalation payload must reach the executor verbatim \u2014 regression guard for the destructure-rebuild bug class (#4477 review)"
      );
      assert.equal(captured.params.taskId, "T01", "taskId must be forwarded");
      assert.equal(captured.params.milestoneId, "M001", "milestoneId must be forwarded");
      assert.deepEqual(
        captured.params.verificationEvidence,
        [{ command: "npm test", exitCode: 0, verdict: "pass", durationMs: 1234 }],
        "verificationEvidence must be forwarded (existing field)"
      );
      assert.equal(
        captured.params.projectDir,
        void 0,
        "projectDir must NOT appear in params \u2014 it's stripped via the spread destructure"
      );
    } finally {
      if (prevModule === void 0) {
        delete process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
      } else {
        process.env.GSD_WORKFLOW_EXECUTORS_MODULE = prevModule;
      }
      if (prevCapture === void 0) {
        delete process.env.GSD_TEST_TASK_COMPLETE_CAPTURE_PATH;
      } else {
        process.env.GSD_TEST_TASK_COMPLETE_CAPTURE_PATH = prevCapture;
      }
      cleanup(base);
    }
  });
  it("gsd_complete_task alias delegates to gsd_task_complete behavior", async () => {
    const base = makeTmpBase();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M002", "slices", "S02"), { recursive: true });
      writeFileSync(
        join(base, ".gsd", "milestones", "M002", "slices", "S02", "S02-PLAN.md"),
        "# S02\n\n- [ ] **T02: Demo** `est:5m`\n"
      );
      const server = makeMockServer();
      registerWorkflowTools(server);
      const aliasTool = server.tools.find((t) => t.name === "gsd_complete_task");
      assert.ok(aliasTool, "task completion alias should be registered");
      const result = await aliasTool.handler({
        projectDir: base,
        taskId: "T02",
        sliceId: "S02",
        milestoneId: "M002",
        oneLiner: "Completed task via alias",
        narrative: "Did the work through alias",
        verification: "npm test"
      });
      assert.match(result.content[0].text, /Completed task T02/);
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M002", "slices", "S02", "tasks", "T02-SUMMARY.md")),
        "alias should write task summary to disk"
      );
    } finally {
      cleanup(base);
    }
  });
  it("gsd_plan_milestone and gsd_plan_slice work end-to-end", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      const sliceTool = server.tools.find((t) => t.name === "gsd_plan_slice");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      assert.ok(sliceTool, "slice planning tool should be registered");
      const milestoneResult = await milestoneTool.handler({
        projectDir: base,
        milestoneId: "M001",
        title: "Workflow MCP planning",
        vision: "Plan milestone over MCP.",
        slices: [
          {
            sliceId: "S01",
            title: "Bridge planning",
            risk: "medium",
            depends: [],
            demo: "Milestone plan persists through MCP.",
            goal: "Persist roadmap state.",
            successCriteria: "ROADMAP.md renders from DB.",
            proofLevel: "integration",
            integrationClosure: "Prompts and MCP call the same handler.",
            observabilityImpact: "Executor tests cover output paths."
          }
        ]
      });
      assert.match(milestoneResult.content[0].text, /Planned milestone M001/);
      const sliceResult = await sliceTool.handler({
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        goal: "Persist slice plan over MCP.",
        tasks: [
          {
            taskId: "T01",
            title: "Add planning bridge",
            description: "Implement the shared executor path.",
            estimate: "15m",
            files: ["src/resources/extensions/gsd/tools/workflow-tool-executors.ts"],
            verify: "node --test",
            inputs: [".gsd/milestones/M001/M001-ROADMAP.md"],
            expectedOutput: ["S01-PLAN.md", "T01-PLAN.md"]
          }
        ]
      });
      assert.match(sliceResult.content[0].text, /Planned slice S01/);
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md")),
        "slice plan should exist on disk"
      );
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-PLAN.md")),
        "task plan should exist on disk"
      );
    } finally {
      cleanup(base);
    }
  });
  it("other workflow tools reject empty required strings at the schema layer", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server);
      const expectRejection = async (toolName, args, expectedField) => {
        const tool = server.tools.find((t) => t.name === toolName);
        assert.ok(tool, `${toolName} should be registered`);
        const result = await tool.handler(args);
        assertToolError(result, expectedField);
      };
      await expectRejection("gsd_plan_slice", {
        projectDir: base,
        milestoneId: "M001",
        sliceId: "",
        goal: "Persist slice plan.",
        tasks: []
      }, "sliceId");
      await expectRejection("gsd_plan_slice", {
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        goal: "Persist slice plan.",
        tasks: [
          {
            taskId: "T01",
            title: "Add bridge",
            description: "Implement bridge.",
            estimate: "15m",
            files: ["src/x.ts"],
            verify: "",
            inputs: ["ROADMAP.md"],
            expectedOutput: ["S01-PLAN.md"]
          }
        ]
      }, "verify");
      await expectRejection("gsd_plan_slice", {
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        goal: "Persist slice plan.",
        tasks: [
          {
            taskId: "T01",
            title: "Add bridge",
            description: "Implement bridge.",
            estimate: "15m",
            files: ["src/x.ts", "   "],
            verify: "node --test",
            inputs: ["ROADMAP.md"],
            expectedOutput: ["S01-PLAN.md"]
          }
        ]
      }, "files");
      await expectRejection("gsd_plan_task", {
        projectDir: base,
        milestoneId: "",
        sliceId: "S01",
        taskId: "T01",
        title: "t",
        description: "d",
        estimate: "1m",
        files: [],
        verify: "v",
        inputs: [],
        expectedOutput: []
      }, "milestoneId");
      await expectRejection("gsd_plan_task", {
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        taskId: "T01",
        title: "t",
        description: "d",
        estimate: "1m",
        files: [],
        verify: "v",
        inputs: [],
        expectedOutput: [],
        observabilityImpact: "   "
      }, "observabilityImpact");
      await expectRejection("gsd_reassess_roadmap", {
        projectDir: base,
        milestoneId: "M001",
        completedSliceId: "S01",
        verdict: "roadmap-confirmed",
        assessment: "",
        sliceChanges: { modified: [], added: [], removed: [] }
      }, "assessment");
      await expectRejection("gsd_plan_milestone", {
        projectDir: base,
        milestoneId: "M001",
        title: "T",
        vision: "V",
        slices: [],
        keyRisks: [{ risk: "", whyItMatters: "because." }]
      }, "risk");
      await expectRejection("gsd_replan_slice", {
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        blockerTaskId: "T01",
        blockerDescription: "",
        whatChanged: "x",
        updatedTasks: [],
        removedTaskIds: []
      }, "blockerDescription");
      await expectRejection("gsd_task_complete", {
        projectDir: base,
        taskId: "T01",
        sliceId: "S01",
        milestoneId: "",
        oneLiner: "ol",
        narrative: "n",
        verification: "v"
      }, "milestoneId");
    } finally {
      cleanup(base);
    }
  });
  it("gsd_plan_milestone rejects empty slice fields up front with all violations", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      const result = await milestoneTool.handler({
        projectDir: base,
        milestoneId: "M001",
        title: "Workflow MCP planning",
        vision: "Plan milestone over MCP.",
        slices: [
          {
            sliceId: "S01",
            title: "Bridge planning",
            risk: "medium",
            depends: [],
            demo: "Milestone plan persists through MCP.",
            goal: "Persist roadmap state.",
            successCriteria: "",
            proofLevel: "",
            integrationClosure: "   ",
            observabilityImpact: ""
          }
        ]
      });
      const message = assertToolError(result, "successCriteria");
      for (const field of ["successCriteria", "proofLevel", "integrationClosure", "observabilityImpact"]) {
        assert.ok(
          message.includes(field),
          `parse error should mention ${field}, got: ${message}`
        );
      }
    } finally {
      cleanup(base);
    }
  });
  it("gsd_plan_milestone rejects a full slice with missing heavy fields via a behavioral round-trip", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      const fullResult = await milestoneTool.handler({
        projectDir: base,
        milestoneId: "M001",
        title: "Full slice path",
        vision: "Behavioral test for isSketch conditional.",
        slices: [
          {
            sliceId: "S01",
            title: "Heavy slice",
            risk: "medium",
            depends: [],
            demo: "Demo.",
            goal: "Goal."
            // heavy fields intentionally omitted
          }
        ]
      });
      const fullMsg = assertToolError(fullResult, "successCriteria");
      for (const field of ["successCriteria", "proofLevel", "integrationClosure", "observabilityImpact"]) {
        assert.ok(
          fullMsg.includes(field),
          `rejection must name ${field} so agents can recover without a second round-trip; got: ${fullMsg}`
        );
      }
      const sketchResult = await milestoneTool.handler({
        projectDir: base,
        milestoneId: "M002",
        title: "Sketch slice path",
        vision: "Behavioral test for isSketch conditional.",
        slices: [
          {
            sliceId: "S01",
            title: "Sketch slice",
            risk: "medium",
            depends: [],
            demo: "Demo.",
            goal: "Goal.",
            isSketch: true,
            sketchScope: "Two-sentence scope. Boundary defined."
          }
        ]
      });
      assert.match(
        sketchResult.content[0].text,
        /Planned milestone M002/,
        "sketch slice with isSketch=true must be accepted by the handler"
      );
    } finally {
      cleanup(base);
    }
  });
  it("gsd_plan_milestone requires sketchScope when isSketch=true and skips heavy fields", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      const emptySketchResult = await milestoneTool.handler({
        projectDir: base,
        milestoneId: "M001",
        title: "Sketch milestone",
        vision: "Sketch first, refine later.",
        slices: [
          {
            sliceId: "S01",
            title: "Sketch slice",
            risk: "low",
            depends: [],
            demo: "Stub demo.",
            goal: "Stub goal.",
            isSketch: true,
            sketchScope: ""
          }
        ]
      });
      assertToolError(emptySketchResult, "sketchScope");
      const sketchResult = await milestoneTool.handler({
        projectDir: base,
        milestoneId: "M001",
        title: "Sketch milestone",
        vision: "Sketch first, refine later.",
        slices: [
          {
            sliceId: "S01",
            title: "Sketch slice",
            risk: "low",
            depends: [],
            demo: "Stub demo.",
            goal: "Stub goal.",
            isSketch: true,
            sketchScope: "Defer heavy planning fields until refine-slice."
          }
        ]
      });
      assert.match(sketchResult.content[0].text, /Planned milestone M001/);
    } finally {
      cleanup(base);
    }
  });
  it("gsd_requirement_save opens the DB before inline requirement writes", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server);
      const requirementTool = server.tools.find((t) => t.name === "gsd_requirement_save");
      assert.ok(requirementTool, "requirement tool should be registered");
      closeDatabase();
      const result = await requirementTool.handler({
        projectDir: base,
        class: "operability",
        description: "Inline MCP requirement save regression",
        why: "Reproduce missing ensureDbOpen in workflow-tools",
        source: "user",
        status: "active",
        primary_owner: "M010/S10",
        validation: "n/a"
      });
      assert.match(result.content[0].text, /Saved requirement R\d+/);
      assert.ok(existsSync(join(base, ".gsd", "REQUIREMENTS.md")), "REQUIREMENTS.md should be written to disk");
      const row = _getAdapter().prepare("SELECT id, class, description FROM requirements WHERE description = ?").get("Inline MCP requirement save regression");
      assert.ok(row, "requirement should be written to the database");
      assert.equal(row["class"], "operability");
    } finally {
      cleanup(base);
    }
  });
  it("gsd_milestone_generate_id skips DB-only queued milestone rows", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server);
      const tool = server.tools.find((t) => t.name === "gsd_milestone_generate_id");
      assert.ok(tool, "milestone ID tool should be registered");
      const first = await tool.handler({ projectDir: base });
      assert.equal(first.content[0].text, "M001");
      assert.ok(!existsSync(join(base, ".gsd", "milestones", "M001")), "ID generation should not create a milestone dir");
      closeDatabase();
      const second = await tool.handler({ projectDir: base });
      assert.equal(second.content[0].text, "M002");
      const rows = _getAdapter().prepare("SELECT id FROM milestones ORDER BY id").all();
      assert.deepEqual(rows.map((row) => row["id"]), ["M001", "M002"]);
    } finally {
      cleanup(base);
    }
  });
  it("gsd_plan_task reopens the DB before inline task planning writes", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      const sliceTool = server.tools.find((t) => t.name === "gsd_plan_slice");
      const taskTool = server.tools.find((t) => t.name === "gsd_plan_task");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      assert.ok(sliceTool, "slice planning tool should be registered");
      assert.ok(taskTool, "task planning tool should be registered");
      await milestoneTool.handler({
        projectDir: base,
        milestoneId: "M010",
        title: "Inline task planning DB reopen",
        vision: "Seed a slice, close the DB, then plan another task inline.",
        slices: [
          {
            sliceId: "S10",
            title: "Inline task planning",
            risk: "medium",
            depends: [],
            demo: "Inline gsd_plan_task reopens the DB after it was closed.",
            goal: "Preserve MCP task planning after the DB adapter is closed.",
            successCriteria: "The second task plan persists after a closed DB is reopened.",
            proofLevel: "integration",
            integrationClosure: "The inline MCP handler reopens the DB before planning.",
            observabilityImpact: "workflow-tools MCP tests cover the inline reopen path."
          }
        ]
      });
      await sliceTool.handler({
        projectDir: base,
        milestoneId: "M010",
        sliceId: "S10",
        goal: "Create the initial slice plan before closing the DB.",
        tasks: [
          {
            taskId: "T10",
            title: "Seed existing task",
            description: "Create the initial task plan before closing the DB.",
            estimate: "5m",
            files: ["packages/mcp-server/src/workflow-tools.ts"],
            verify: "node --test",
            inputs: ["M010-ROADMAP.md"],
            expectedOutput: ["T10-PLAN.md"]
          }
        ]
      });
      closeDatabase();
      const result = await taskTool.handler({
        projectDir: base,
        milestoneId: "M010",
        sliceId: "S10",
        taskId: "T11",
        title: "Reopen and plan",
        description: "Exercise the inline plan-task path after the DB was closed.",
        estimate: "5m",
        files: ["packages/mcp-server/src/workflow-tools.ts"],
        verify: "node --test",
        inputs: ["M010-ROADMAP.md", "S10-PLAN.md"],
        expectedOutput: ["T11-PLAN.md"]
      });
      assert.match(result.content[0].text, /Planned task T11/);
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M010", "slices", "S10", "tasks", "T11-PLAN.md")),
        "T11 plan should be written after reopening the DB"
      );
    } finally {
      cleanup(base);
    }
  });
  it("gsd_replan_slice and gsd_slice_replan work end-to-end", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      const sliceTool = server.tools.find((t) => t.name === "gsd_plan_slice");
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      const canonicalTool = server.tools.find((t) => t.name === "gsd_replan_slice");
      const aliasTool = server.tools.find((t) => t.name === "gsd_slice_replan");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      assert.ok(sliceTool, "slice planning tool should be registered");
      assert.ok(taskTool, "task completion tool should be registered");
      assert.ok(canonicalTool, "slice replanning tool should be registered");
      assert.ok(aliasTool, "slice replanning alias should be registered");
      await milestoneTool.handler({
        projectDir: base,
        milestoneId: "M099",
        title: "Slice replanning",
        vision: "Drive replan parity over MCP.",
        slices: [
          {
            sliceId: "S09",
            title: "Replan slice",
            risk: "medium",
            depends: [],
            demo: "Slice replans after a blocker task completes.",
            goal: "Prepare replan state.",
            successCriteria: "Plan and replan artifacts update over MCP.",
            proofLevel: "integration",
            integrationClosure: "Replan uses the shared executor path.",
            observabilityImpact: "Tests cover replan artifacts."
          }
        ]
      });
      await sliceTool.handler({
        projectDir: base,
        milestoneId: "M099",
        sliceId: "S09",
        goal: "Plan a slice that will be replanned.",
        tasks: [
          {
            taskId: "T09",
            title: "Blocker task",
            description: "Finish the blocker-discovery task.",
            estimate: "5m",
            files: ["src/blocker.ts"],
            verify: "node --test",
            inputs: ["M099-ROADMAP.md"],
            expectedOutput: ["T09-SUMMARY.md"]
          },
          {
            taskId: "T10",
            title: "Pending task",
            description: "Original follow-up task.",
            estimate: "10m",
            files: ["src/pending.ts"],
            verify: "node --test",
            inputs: ["S09-PLAN.md"],
            expectedOutput: ["Updated plan"]
          }
        ]
      });
      await taskTool.handler({
        projectDir: base,
        milestoneId: "M099",
        sliceId: "S09",
        taskId: "T09",
        oneLiner: "Completed blocker task",
        narrative: "Prepared the slice for replanning.",
        verification: "node --test"
      });
      const canonicalResult = await canonicalTool.handler({
        projectDir: base,
        milestoneId: "M099",
        sliceId: "S09",
        blockerTaskId: "T09",
        blockerDescription: "Original approach is no longer viable.",
        whatChanged: "Updated the remaining task and added remediation work.",
        updatedTasks: [
          {
            taskId: "T10",
            title: "Pending task (updated)",
            description: "Updated follow-up task after replanning.",
            estimate: "15m",
            files: ["src/pending.ts", "src/replanned.ts"],
            verify: "node --test",
            inputs: ["S09-PLAN.md"],
            expectedOutput: ["Updated plan"]
          },
          {
            taskId: "T11",
            title: "Remediation task",
            description: "New task introduced by the replan.",
            estimate: "20m",
            files: ["src/remediation.ts"],
            verify: "node --test",
            inputs: ["S09-REPLAN.md"],
            expectedOutput: ["Remediation patch"]
          }
        ],
        removedTaskIds: []
      });
      assert.match(canonicalResult.content[0].text, /Replanned slice S09/);
      const aliasResult = await aliasTool.handler({
        projectDir: base,
        milestoneId: "M099",
        sliceId: "S09",
        blockerTaskId: "T09",
        blockerDescription: "Alias path confirms the same replan flow.",
        whatChanged: "Removed the remediation task after the alias check.",
        updatedTasks: [
          {
            taskId: "T10",
            title: "Pending task (updated again)",
            description: "Alias adjusted the remaining pending task.",
            estimate: "12m",
            files: ["src/pending.ts"],
            verify: "node --test",
            inputs: ["S09-PLAN.md"],
            expectedOutput: ["Updated plan"]
          }
        ],
        removedTaskIds: ["T11"]
      });
      assert.match(aliasResult.content[0].text, /Replanned slice S09/);
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M099", "slices", "S09", "S09-REPLAN.md")),
        "replan artifact should exist on disk"
      );
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M099", "slices", "S09", "S09-PLAN.md")),
        "updated plan should exist on disk"
      );
      const removedTask = _getAdapter().prepare(
        "SELECT id FROM tasks WHERE milestone_id = ? AND slice_id = ? AND id = ?"
      ).get("M099", "S09", "T11");
      assert.equal(removedTask, void 0, "alias should remove the replanned task");
    } finally {
      cleanup(base);
    }
  });
  it("gsd_slice_complete and gsd_complete_slice work end-to-end", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      const sliceTool = server.tools.find((t) => t.name === "gsd_plan_slice");
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      const canonicalTool = server.tools.find((t) => t.name === "gsd_slice_complete");
      const aliasTool = server.tools.find((t) => t.name === "gsd_complete_slice");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      assert.ok(sliceTool, "slice planning tool should be registered");
      assert.ok(taskTool, "task completion tool should be registered");
      assert.ok(canonicalTool, "slice completion tool should be registered");
      assert.ok(aliasTool, "slice completion alias should be registered");
      await milestoneTool.handler({
        projectDir: base,
        milestoneId: "M003",
        title: "Demo milestone",
        vision: "Prepare canonical slice completion state.",
        slices: [
          {
            sliceId: "S03",
            title: "Demo Slice",
            risk: "medium",
            depends: [],
            demo: "Canonical slice completes through MCP.",
            goal: "Seed workflow state.",
            successCriteria: "Slice summary and UAT files are written.",
            proofLevel: "integration",
            integrationClosure: "Planning and completion share the MCP bridge.",
            observabilityImpact: "Workflow tests cover canonical completion."
          }
        ]
      });
      await sliceTool.handler({
        projectDir: base,
        milestoneId: "M003",
        sliceId: "S03",
        goal: "Complete canonical slice over MCP.",
        tasks: [
          {
            taskId: "T03",
            title: "Canonical task",
            description: "Seed a completed task for slice completion.",
            estimate: "5m",
            files: ["packages/mcp-server/src/workflow-tools.ts"],
            verify: "node --test",
            inputs: ["M003-ROADMAP.md"],
            expectedOutput: ["S03-SUMMARY.md", "S03-UAT.md"]
          }
        ]
      });
      await taskTool.handler({
        projectDir: base,
        milestoneId: "M003",
        sliceId: "S03",
        taskId: "T03",
        oneLiner: "Completed canonical task",
        narrative: "Prepared the canonical slice for completion.",
        verification: "node --test"
      });
      const canonicalResult = await canonicalTool.handler({
        projectDir: base,
        milestoneId: "M003",
        sliceId: "S03",
        sliceTitle: "Demo Slice",
        oneLiner: "Completed canonical slice",
        narrative: "Did the slice work",
        verification: "npm test",
        uatContent: "## UAT\n\nPASS"
      });
      assert.match(canonicalResult.content[0].text, /Completed slice S03/);
      await milestoneTool.handler({
        projectDir: base,
        milestoneId: "M004",
        title: "Alias milestone",
        vision: "Prepare alias slice completion state.",
        slices: [
          {
            sliceId: "S04",
            title: "Alias Slice",
            risk: "medium",
            depends: [],
            demo: "Alias slice completes through MCP.",
            goal: "Seed alias workflow state.",
            successCriteria: "Alias summary and UAT files are written.",
            proofLevel: "integration",
            integrationClosure: "Alias reaches the shared slice executor.",
            observabilityImpact: "Workflow tests cover alias completion."
          }
        ]
      });
      await sliceTool.handler({
        projectDir: base,
        milestoneId: "M004",
        sliceId: "S04",
        goal: "Complete alias slice over MCP.",
        tasks: [
          {
            taskId: "T04",
            title: "Alias task",
            description: "Seed a completed task for alias slice completion.",
            estimate: "5m",
            files: ["packages/mcp-server/src/workflow-tools.ts"],
            verify: "node --test",
            inputs: ["M004-ROADMAP.md"],
            expectedOutput: ["S04-SUMMARY.md", "S04-UAT.md"]
          }
        ]
      });
      await taskTool.handler({
        projectDir: base,
        milestoneId: "M004",
        sliceId: "S04",
        taskId: "T04",
        oneLiner: "Completed alias task",
        narrative: "Prepared the alias slice for completion.",
        verification: "node --test"
      });
      const aliasResult = await aliasTool.handler({
        projectDir: base,
        milestoneId: "M004",
        sliceId: "S04",
        sliceTitle: "Alias Slice",
        oneLiner: "Completed alias slice",
        narrative: "Did the slice work via alias",
        verification: "npm test",
        uatContent: "## UAT\n\nPASS"
      });
      assert.match(aliasResult.content[0].text, /Completed slice S04/);
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M004", "slices", "S04", "S04-SUMMARY.md")),
        "alias should write slice summary to disk"
      );
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M004", "slices", "S04", "S04-UAT.md")),
        "alias should write slice UAT to disk"
      );
    } finally {
      cleanup(base);
    }
  });
  it("gsd_validate_milestone and gsd_milestone_complete work end-to-end", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      const sliceTool = server.tools.find((t) => t.name === "gsd_plan_slice");
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      const completeSliceTool = server.tools.find((t) => t.name === "gsd_slice_complete");
      const validateTool = server.tools.find((t) => t.name === "gsd_validate_milestone");
      const completeMilestoneAlias = server.tools.find((t) => t.name === "gsd_milestone_complete");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      assert.ok(sliceTool, "slice planning tool should be registered");
      assert.ok(taskTool, "task completion tool should be registered");
      assert.ok(completeSliceTool, "slice completion tool should be registered");
      assert.ok(validateTool, "milestone validation tool should be registered");
      assert.ok(completeMilestoneAlias, "milestone completion alias should be registered");
      await milestoneTool.handler({
        projectDir: base,
        milestoneId: "M005",
        title: "Milestone lifecycle",
        vision: "Drive validation and completion over MCP.",
        slices: [
          {
            sliceId: "S05",
            title: "Lifecycle slice",
            risk: "medium",
            depends: [],
            demo: "Milestone can validate and complete.",
            goal: "Seed milestone completion state.",
            successCriteria: "Summary and validation artifacts are written.",
            proofLevel: "integration",
            integrationClosure: "Lifecycle tools share the MCP bridge.",
            observabilityImpact: "Tests cover milestone end-to-end behavior."
          }
        ]
      });
      await sliceTool.handler({
        projectDir: base,
        milestoneId: "M005",
        sliceId: "S05",
        goal: "Prepare a complete milestone.",
        tasks: [
          {
            taskId: "T05",
            title: "Lifecycle task",
            description: "Seed a fully completed slice.",
            estimate: "10m",
            files: ["packages/mcp-server/src/workflow-tools.ts"],
            verify: "node --test",
            inputs: ["M005-ROADMAP.md"],
            expectedOutput: ["M005-VALIDATION.md", "M005-SUMMARY.md"]
          }
        ]
      });
      await taskTool.handler({
        projectDir: base,
        milestoneId: "M005",
        sliceId: "S05",
        taskId: "T05",
        oneLiner: "Completed lifecycle task",
        narrative: "Prepared the milestone for closure.",
        verification: "node --test"
      });
      await completeSliceTool.handler({
        projectDir: base,
        milestoneId: "M005",
        sliceId: "S05",
        sliceTitle: "Lifecycle Slice",
        oneLiner: "Completed lifecycle slice",
        narrative: "Closed the milestone slice.",
        verification: "node --test",
        uatContent: "## UAT\n\nPASS"
      });
      const validationResult = await validateTool.handler({
        projectDir: base,
        milestoneId: "M005",
        verdict: "pass",
        remediationRound: 0,
        successCriteriaChecklist: "- [x] Lifecycle verified",
        sliceDeliveryAudit: "| Slice | Verdict |\n| --- | --- |\n| S05 | pass |",
        crossSliceIntegration: "No cross-slice mismatches found.",
        requirementCoverage: "No requirement gaps remain.",
        verdictRationale: "The milestone delivered its scope."
      });
      assert.match(validationResult.content[0].text, /Validated milestone M005/);
      const completionResult = await completeMilestoneAlias.handler({
        projectDir: base,
        milestoneId: "M005",
        title: "Milestone lifecycle",
        oneLiner: "Milestone closed successfully",
        narrative: "Validation passed and all slices were complete.",
        verificationPassed: true
      });
      assert.match(completionResult.content[0].text, /Completed milestone M005/);
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M005", "M005-VALIDATION.md")),
        "validation artifact should exist on disk"
      );
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M005", "M005-SUMMARY.md")),
        "milestone summary should exist on disk"
      );
    } finally {
      cleanup(base);
    }
  });
  it("gsd_reassess_roadmap, gsd_roadmap_reassess, and gsd_save_gate_result work end-to-end", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      const sliceTool = server.tools.find((t) => t.name === "gsd_plan_slice");
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      const completeSliceTool = server.tools.find((t) => t.name === "gsd_slice_complete");
      const reassessTool = server.tools.find((t) => t.name === "gsd_reassess_roadmap");
      const reassessAlias = server.tools.find((t) => t.name === "gsd_roadmap_reassess");
      const gateTool = server.tools.find((t) => t.name === "gsd_save_gate_result");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      assert.ok(sliceTool, "slice planning tool should be registered");
      assert.ok(taskTool, "task completion tool should be registered");
      assert.ok(completeSliceTool, "slice completion tool should be registered");
      assert.ok(reassessTool, "roadmap reassessment tool should be registered");
      assert.ok(reassessAlias, "roadmap reassessment alias should be registered");
      assert.ok(gateTool, "gate result tool should be registered");
      await milestoneTool.handler({
        projectDir: base,
        milestoneId: "M006",
        title: "Roadmap reassessment",
        vision: "Drive gate results and reassessment over MCP.",
        slices: [
          {
            sliceId: "S06",
            title: "Completed slice",
            risk: "medium",
            depends: [],
            demo: "Completed slice triggers reassessment.",
            goal: "Seed reassessment state.",
            successCriteria: "Assessment and roadmap artifacts are written.",
            proofLevel: "integration",
            integrationClosure: "Roadmap updates share the MCP bridge.",
            observabilityImpact: "Tests cover reassessment behavior."
          },
          {
            sliceId: "S07",
            title: "Follow-up slice",
            risk: "low",
            depends: ["S06"],
            demo: "Follow-up slice remains pending.",
            goal: "Leave room for roadmap edits.",
            successCriteria: "Roadmap mutation succeeds.",
            proofLevel: "integration",
            integrationClosure: "Pending slice can be modified after reassessment.",
            observabilityImpact: "Tests observe roadmap mutation output."
          }
        ]
      });
      await sliceTool.handler({
        projectDir: base,
        milestoneId: "M006",
        sliceId: "S06",
        goal: "Complete the first slice.",
        tasks: [
          {
            taskId: "T06",
            title: "Seed completed slice",
            description: "Prepare gate and reassessment state.",
            estimate: "10m",
            files: ["packages/mcp-server/src/workflow-tools.ts"],
            verify: "node --test",
            inputs: ["M006-ROADMAP.md"],
            expectedOutput: ["S06-ASSESSMENT.md", "M006-ROADMAP.md"]
          }
        ]
      });
      const gateResult = await gateTool.handler({
        projectDir: base,
        milestoneId: "M006",
        sliceId: "S06",
        gateId: "Q3",
        verdict: "pass",
        rationale: "Threat surface is covered.",
        findings: "No new attack surface was introduced."
      });
      assert.match(gateResult.content[0].text, /Gate Q3 result saved/);
      assert.equal(
        Object.prototype.hasOwnProperty.call(gateResult, "details"),
        false,
        "executor `details` field must be stripped from MCP tool result"
      );
      assert.deepEqual(
        gateResult.structuredContent,
        { operation: "save_gate_result", gateId: "Q3", verdict: "pass" },
        "executor details must be forwarded on the MCP `structuredContent` channel"
      );
      const gateRows = _getAdapter().prepare(
        "SELECT status, verdict, rationale FROM quality_gates WHERE milestone_id = ? AND slice_id = ? AND gate_id = ?"
      ).all("M006", "S06", "Q3");
      assert.equal(gateRows.length, 1);
      assert.equal(gateRows[0]["status"], "complete");
      assert.equal(gateRows[0]["verdict"], "pass");
      await taskTool.handler({
        projectDir: base,
        milestoneId: "M006",
        sliceId: "S06",
        taskId: "T06",
        oneLiner: "Completed reassessment task",
        narrative: "Prepared the slice for reassessment.",
        verification: "node --test"
      });
      await completeSliceTool.handler({
        projectDir: base,
        milestoneId: "M006",
        sliceId: "S06",
        sliceTitle: "Completed slice",
        oneLiner: "Completed reassessment slice",
        narrative: "Closed the completed slice before reassessment.",
        verification: "node --test",
        uatContent: "## UAT\n\nPASS"
      });
      const reassessResult = await reassessTool.handler({
        projectDir: base,
        milestoneId: "M006",
        completedSliceId: "S06",
        verdict: "roadmap-adjusted",
        assessment: "Insert remediation work after the completed slice.",
        sliceChanges: {
          modified: [
            {
              sliceId: "S07",
              title: "Follow-up slice (adjusted)",
              risk: "medium",
              depends: ["S06"],
              demo: "Adjusted demo"
            }
          ],
          added: [
            {
              sliceId: "S08",
              title: "Remediation slice",
              risk: "high",
              depends: ["S07"],
              demo: "Remediation demo"
            }
          ],
          removed: []
        }
      });
      assert.match(reassessResult.content[0].text, /Reassessed roadmap for milestone M006 after S06/);
      const reassessAliasResult = await reassessAlias.handler({
        projectDir: base,
        milestoneId: "M006",
        completedSliceId: "S06",
        verdict: "roadmap-confirmed",
        assessment: "No further changes needed after the first reassessment.",
        sliceChanges: {
          modified: [],
          added: [],
          removed: []
        }
      });
      assert.match(reassessAliasResult.content[0].text, /Reassessed roadmap for milestone M006 after S06/);
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M006", "slices", "S06", "S06-ASSESSMENT.md")),
        "assessment artifact should exist on disk"
      );
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M006", "M006-ROADMAP.md")),
        "roadmap artifact should exist on disk"
      );
    } finally {
      cleanup(base);
    }
  });
});
describe("URL scheme regex \u2014 Windows drive letter safety", () => {
  const urlSchemeRegex = /^[a-z]{2,}:/i;
  it("rejects multi-letter URL schemes", () => {
    assert.ok(urlSchemeRegex.test("http://example.com"), "http: should match");
    assert.ok(urlSchemeRegex.test("https://example.com"), "https: should match");
    assert.ok(urlSchemeRegex.test("ftp://files.example.com"), "ftp: should match");
    assert.ok(urlSchemeRegex.test("file:///C:/Users"), "file: should match");
    assert.ok(urlSchemeRegex.test("node:fs"), "node: should match");
  });
  it("allows single-letter Windows drive prefixes", () => {
    assert.ok(!urlSchemeRegex.test("C:\\Users\\user\\project"), "C:\\ should not match");
    assert.ok(!urlSchemeRegex.test("D:\\other\\path"), "D:\\ should not match");
    assert.ok(!urlSchemeRegex.test("c:\\lowercase\\drive"), "c:\\ should not match");
    assert.ok(!urlSchemeRegex.test("E:/forward/slash/path"), "E:/ should not match");
  });
  it("allows bare filesystem paths", () => {
    assert.ok(!urlSchemeRegex.test("/usr/local/lib/module.js"), "unix absolute path should not match");
    assert.ok(!urlSchemeRegex.test("./relative/path.js"), "relative path should not match");
    assert.ok(!urlSchemeRegex.test("../parent/path.js"), "parent relative path should not match");
  });
});
describe("validateProjectDir", () => {
  it("rejects a symlink inside the allowed root that points outside it", () => {
    const allowedRoot = makeTmpBase();
    const outside = makeTmpBase();
    const linkInside = join(allowedRoot, "escape-link");
    symlinkSync(outside, linkInside, "dir");
    const prevRoot = process.env.GSD_WORKFLOW_PROJECT_ROOT;
    try {
      process.env.GSD_WORKFLOW_PROJECT_ROOT = allowedRoot;
      assert.throws(
        () => validateProjectDir(linkInside),
        /configured workflow project root/,
        "symlink-to-outside must not bypass the containment check"
      );
    } finally {
      if (prevRoot === void 0) {
        delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
      } else {
        process.env.GSD_WORKFLOW_PROJECT_ROOT = prevRoot;
      }
      cleanup(allowedRoot);
      cleanup(outside);
    }
  });
  it("accepts a non-existent path inside the allowed root (new worktree case)", () => {
    const allowedRoot = makeTmpBase();
    const canonicalRoot = realpathSync(allowedRoot);
    const futureWorktree = join(canonicalRoot, "worktrees", "M999-not-yet-created");
    const prevRoot = process.env.GSD_WORKFLOW_PROJECT_ROOT;
    try {
      process.env.GSD_WORKFLOW_PROJECT_ROOT = canonicalRoot;
      const result = validateProjectDir(futureWorktree);
      assert.equal(result, futureWorktree, "ENOENT should fall back to the lexical path, not throw");
    } finally {
      if (prevRoot === void 0) {
        delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
      } else {
        process.env.GSD_WORKFLOW_PROJECT_ROOT = prevRoot;
      }
      cleanup(allowedRoot);
    }
  });
  it("accepts a real directory inside the allowed root", () => {
    const allowedRoot = makeTmpBase();
    const child = join(allowedRoot, "child");
    mkdirSync(child, { recursive: true });
    const prevRoot = process.env.GSD_WORKFLOW_PROJECT_ROOT;
    try {
      process.env.GSD_WORKFLOW_PROJECT_ROOT = allowedRoot;
      const result = validateProjectDir(child);
      assert.ok(result.endsWith("child"), `expected resolved path to end with 'child', got ${result}`);
    } finally {
      if (prevRoot === void 0) {
        delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
      } else {
        process.env.GSD_WORKFLOW_PROJECT_ROOT = prevRoot;
      }
      cleanup(allowedRoot);
    }
  });
  it("accepts a worktree under the allowed root external .gsd state target", () => {
    const allowedRoot = makeTmpBase();
    const externalState = makeTmpBase();
    const worktree = join(externalState, "worktrees", "M001");
    mkdirSync(worktree, { recursive: true });
    rmSync(join(allowedRoot, ".gsd"), { recursive: true, force: true });
    symlinkSync(externalState, join(allowedRoot, ".gsd"), "dir");
    const prevRoot = process.env.GSD_WORKFLOW_PROJECT_ROOT;
    try {
      process.env.GSD_WORKFLOW_PROJECT_ROOT = allowedRoot;
      const result = validateProjectDir(worktree);
      assert.equal(result, realpathSync(worktree));
    } finally {
      if (prevRoot === void 0) {
        delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
      } else {
        process.env.GSD_WORKFLOW_PROJECT_ROOT = prevRoot;
      }
      cleanup(allowedRoot);
      cleanup(externalState);
    }
  });
  it("rejects external-state sibling paths that only share a prefix", () => {
    const allowedRoot = makeTmpBase();
    const externalState = makeTmpBase();
    const sibling = `${externalState}-sibling`;
    const siblingWorktree = join(sibling, "worktrees", "M001");
    mkdirSync(siblingWorktree, { recursive: true });
    rmSync(join(allowedRoot, ".gsd"), { recursive: true, force: true });
    symlinkSync(externalState, join(allowedRoot, ".gsd"), "dir");
    const prevRoot = process.env.GSD_WORKFLOW_PROJECT_ROOT;
    try {
      process.env.GSD_WORKFLOW_PROJECT_ROOT = allowedRoot;
      assert.throws(
        () => validateProjectDir(siblingWorktree),
        /configured workflow project root/
      );
    } finally {
      if (prevRoot === void 0) {
        delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
      } else {
        process.env.GSD_WORKFLOW_PROJECT_ROOT = prevRoot;
      }
      cleanup(allowedRoot);
      cleanup(externalState);
      cleanup(sibling);
    }
  });
  it("rejects relative paths", () => {
    assert.throws(
      () => validateProjectDir("relative/path"),
      /must be an absolute path/
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvbWNwLXNlcnZlci9zcmMvd29ya2Zsb3ctdG9vbHMudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFRlc3RzIHBhY2thZ2VkIHdvcmtmbG93IHRvb2xzIGV4cG9zZWQgYnkgdGhlIEdTRCBNQ1Agc2VydmVyLlxuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jLCByZWFkRmlsZVN5bmMsIGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5cbmltcG9ydCB7IHN5bWxpbmtTeW5jLCByZWFscGF0aFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuXG5pbXBvcnQgeyBfZ2V0QWRhcHRlciwgY2xvc2VEYXRhYmFzZSB9IGZyb20gXCIuLi8uLi8uLi9zcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2dzZC1kYi50c1wiO1xuaW1wb3J0IHsgX2J1aWxkSW1wb3J0Q2FuZGlkYXRlcywgcmVnaXN0ZXJXb3JrZmxvd1Rvb2xzLCBXT1JLRkxPV19UT09MX05BTUVTLCB2YWxpZGF0ZVByb2plY3REaXIgfSBmcm9tIFwiLi93b3JrZmxvdy10b29scy50c1wiO1xuXG5mdW5jdGlvbiBtYWtlVG1wQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gam9pbih0bXBkaXIoKSwgYGdzZC1tY3Atd29ya2Zsb3ctJHtyYW5kb21VVUlEKCl9YCk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5mdW5jdGlvbiBjbGVhbnVwKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICB0cnkge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gc3dhbGxvd1xuICB9XG4gIHRyeSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gc3dhbGxvd1xuICB9XG59XG5cbmZ1bmN0aW9uIHdyaXRlV3JpdGVHYXRlU25hcHNob3QoXG4gIGJhc2U6IHN0cmluZyxcbiAgc25hcHNob3Q6IHsgdmVyaWZpZWREZXB0aE1pbGVzdG9uZXM/OiBzdHJpbmdbXTsgYWN0aXZlUXVldWVQaGFzZT86IGJvb2xlYW47IHBlbmRpbmdHYXRlSWQ/OiBzdHJpbmcgfCBudWxsIH0sXG4pOiB2b2lkIHtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIsIFwid3JpdGUtZ2F0ZS1zdGF0ZS5qc29uXCIpLFxuICAgIEpTT04uc3RyaW5naWZ5KFxuICAgICAge1xuICAgICAgICB2ZXJpZmllZERlcHRoTWlsZXN0b25lczogc25hcHNob3QudmVyaWZpZWREZXB0aE1pbGVzdG9uZXMgPz8gW10sXG4gICAgICAgIGFjdGl2ZVF1ZXVlUGhhc2U6IHNuYXBzaG90LmFjdGl2ZVF1ZXVlUGhhc2UgPz8gZmFsc2UsXG4gICAgICAgIHBlbmRpbmdHYXRlSWQ6IHNuYXBzaG90LnBlbmRpbmdHYXRlSWQgPz8gbnVsbCxcbiAgICAgIH0sXG4gICAgICBudWxsLFxuICAgICAgMixcbiAgICApLFxuICAgIFwidXRmLThcIixcbiAgKTtcbn1cblxuZnVuY3Rpb24gbWFrZU1vY2tTZXJ2ZXIoKSB7XG4gIGNvbnN0IHRvb2xzOiBBcnJheTx7XG4gICAgbmFtZTogc3RyaW5nO1xuICAgIGRlc2NyaXB0aW9uOiBzdHJpbmc7XG4gICAgcGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBoYW5kbGVyOiAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IFByb21pc2U8dW5rbm93bj47XG4gIH0+ID0gW107XG4gIHJldHVybiB7XG4gICAgdG9vbHMsXG4gICAgdG9vbChcbiAgICAgIG5hbWU6IHN0cmluZyxcbiAgICAgIGRlc2NyaXB0aW9uOiBzdHJpbmcsXG4gICAgICBwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgICAgaGFuZGxlcjogKGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBQcm9taXNlPHVua25vd24+LFxuICAgICkge1xuICAgICAgdG9vbHMucHVzaCh7IG5hbWUsIGRlc2NyaXB0aW9uLCBwYXJhbXMsIGhhbmRsZXIgfSk7XG4gICAgfSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gYXNzZXJ0VG9vbEVycm9yKHJlc3VsdDogdW5rbm93biwgZXhwZWN0ZWQ6IFJlZ0V4cCB8IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHJlY29yZCA9IHJlc3VsdCBhcyB7IGlzRXJyb3I/OiBib29sZWFuOyBjb250ZW50PzogQXJyYXk8eyB0ZXh0PzogdW5rbm93biB9PiB9O1xuICBhc3NlcnQuZXF1YWwocmVjb3JkLmlzRXJyb3IsIHRydWUsIFwidG9vbCByZXN1bHQgc2hvdWxkIGJlIG1hcmtlZCBhcyBhbiBNQ1AgZXJyb3JcIik7XG4gIGNvbnN0IHRleHQgPSByZWNvcmQuY29udGVudD8uWzBdPy50ZXh0O1xuICBhc3NlcnQuZXF1YWwodHlwZW9mIHRleHQsIFwic3RyaW5nXCIsIFwidG9vbCBlcnJvciByZXN1bHQgc2hvdWxkIGNvbnRhaW4gdGV4dFwiKTtcbiAgaWYgKGV4cGVjdGVkIGluc3RhbmNlb2YgUmVnRXhwKSB7XG4gICAgYXNzZXJ0Lm1hdGNoKHRleHQsIGV4cGVjdGVkKTtcbiAgfSBlbHNlIHtcbiAgICBhc3NlcnQub2sodGV4dC5pbmNsdWRlcyhleHBlY3RlZCksIGBlcnJvciBzaG91bGQgbWVudGlvbiAke2V4cGVjdGVkfSwgZ290OiAke3RleHR9YCk7XG4gIH1cbiAgcmV0dXJuIHRleHQ7XG59XG5cbmZ1bmN0aW9uIGNhY2hlQnVzdGVkV29ya2Zsb3dUb29sc0ltcG9ydCh0YWc6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGV4dGVuc2lvbiA9IGltcG9ydC5tZXRhLnVybC5pbmNsdWRlcyhcIi9kaXN0LXRlc3QvXCIpID8gXCJqc1wiIDogXCJ0c1wiO1xuICByZXR1cm4gYC4vd29ya2Zsb3ctdG9vbHMuJHtleHRlbnNpb259PyR7dGFnfT0ke3JhbmRvbVVVSUQoKX1gO1xufVxuXG5kZXNjcmliZShcIndvcmtmbG93IE1DUCB0b29sc1wiLCAoKSA9PiB7XG4gIGl0KFwicmVnaXN0ZXJzIHRoZSBmdWxsIGhlYWRsZXNzLXNhZmUgd29ya2Zsb3cgdG9vbCBzdXJmYWNlXCIsICgpID0+IHtcbiAgICBjb25zdCBzZXJ2ZXIgPSBtYWtlTW9ja1NlcnZlcigpO1xuICAgIHJlZ2lzdGVyV29ya2Zsb3dUb29scyhzZXJ2ZXIgYXMgYW55KTtcblxuICAgIGFzc2VydC5lcXVhbChzZXJ2ZXIudG9vbHMubGVuZ3RoLCBXT1JLRkxPV19UT09MX05BTUVTLmxlbmd0aCk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChzZXJ2ZXIudG9vbHMubWFwKCh0KSA9PiB0Lm5hbWUpLCBbLi4uV09SS0ZMT1dfVE9PTF9OQU1FU10pO1xuICB9KTtcblxuICBpdChcInJlZ2lzdGVycyB0YXNrIHJlb3BlbiBpbiB0aGUgd29ya2Zsb3cgTUNQIHRvb2wgc3VyZmFjZVwiLCAoKSA9PiB7XG4gICAgY29uc3Qgc2VydmVyID0gbWFrZU1vY2tTZXJ2ZXIoKTtcbiAgICByZWdpc3RlcldvcmtmbG93VG9vbHMoc2VydmVyIGFzIGFueSk7XG5cbiAgICBjb25zdCB0b29sTmFtZXMgPSBzZXJ2ZXIudG9vbHMubWFwKCh0KSA9PiB0Lm5hbWUpO1xuICAgIGFzc2VydC5vayh0b29sTmFtZXMuaW5jbHVkZXMoXCJnc2RfdGFza19yZW9wZW5cIikpO1xuICAgIGFzc2VydC5vayh0b29sTmFtZXMuaW5jbHVkZXMoXCJnc2RfcmVvcGVuX3Rhc2tcIikpO1xuXG4gICAgY29uc3QgdGFza1Jlb3BlbiA9IHNlcnZlci50b29scy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09IFwiZ3NkX3Rhc2tfcmVvcGVuXCIpO1xuICAgIGFzc2VydC5vayh0YXNrUmVvcGVuKTtcbiAgICBhc3NlcnQub2soXCJtaWxlc3RvbmVJZFwiIGluIHRhc2tSZW9wZW4ucGFyYW1zKTtcbiAgICBhc3NlcnQub2soXCJzbGljZUlkXCIgaW4gdGFza1Jlb3Blbi5wYXJhbXMpO1xuICAgIGFzc2VydC5vayhcInRhc2tJZFwiIGluIHRhc2tSZW9wZW4ucGFyYW1zKTtcbiAgICBhc3NlcnQub2soXCJyZWFzb25cIiBpbiB0YXNrUmVvcGVuLnBhcmFtcyk7XG4gIH0pO1xuXG4gIGl0KFwicHJlZmVycyBzb3VyY2UgVHlwZVNjcmlwdCBiZWZvcmUgY29tcGlsZWQgZGlzdCBmYWxsYmFja3NcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgICBfYnVpbGRJbXBvcnRDYW5kaWRhdGVzKFwiLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90b29scy93b3JrZmxvdy10b29sLWV4ZWN1dG9ycy5qc1wiKSxcbiAgICAgIFtcbiAgICAgICAgXCIuLi8uLi8uLi9zcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL3Rvb2xzL3dvcmtmbG93LXRvb2wtZXhlY3V0b3JzLnRzXCIsXG4gICAgICAgIFwiLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90b29scy93b3JrZmxvdy10b29sLWV4ZWN1dG9ycy5qc1wiLFxuICAgICAgICBcIi4uLy4uLy4uL2Rpc3QvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL3Rvb2xzL3dvcmtmbG93LXRvb2wtZXhlY3V0b3JzLnRzXCIsXG4gICAgICAgIFwiLi4vLi4vLi4vZGlzdC9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvdG9vbHMvd29ya2Zsb3ctdG9vbC1leGVjdXRvcnMuanNcIixcbiAgICAgIF0sXG4gICAgKTtcbiAgfSk7XG5cbiAgaXQoXCJnc2Rfc3VtbWFyeV9zYXZlIHdyaXRlcyBhcnRpZmFjdCB0aHJvdWdoIHRoZSBzaGFyZWQgZXhlY3V0b3JcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzZXJ2ZXIgPSBtYWtlTW9ja1NlcnZlcigpO1xuICAgICAgcmVnaXN0ZXJXb3JrZmxvd1Rvb2xzKHNlcnZlciBhcyBhbnkpO1xuICAgICAgY29uc3QgdG9vbCA9IHNlcnZlci50b29scy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09IFwiZ3NkX3N1bW1hcnlfc2F2ZVwiKTtcbiAgICAgIGFzc2VydC5vayh0b29sLCBcInN1bW1hcnkgdG9vbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcbiAgICAgIGNvbnN0IG9yaWdpbmFsQ3dkID0gcHJvY2Vzcy5jd2QoKTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdG9vbCEuaGFuZGxlcih7XG4gICAgICAgIHByb2plY3REaXI6IGJhc2UsXG4gICAgICAgIG1pbGVzdG9uZV9pZDogXCJNMDAxXCIsXG4gICAgICAgIHNsaWNlX2lkOiBcIlMwMVwiLFxuICAgICAgICBhcnRpZmFjdF90eXBlOiBcIlNVTU1BUllcIixcbiAgICAgICAgY29udGVudDogXCIjIFN1bW1hcnlcXG5cXG5IZWxsb1wiLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IHRleHQgPSAocmVzdWx0IGFzIGFueSkuY29udGVudFswXS50ZXh0IGFzIHN0cmluZztcbiAgICAgIGFzc2VydC5tYXRjaCh0ZXh0LCAvU2F2ZWQgU1VNTUFSWSBhcnRpZmFjdC8pO1xuICAgICAgYXNzZXJ0LmVxdWFsKHByb2Nlc3MuY3dkKCksIG9yaWdpbmFsQ3dkLCBcIndvcmtmbG93IE1DUCB0b29scyBzaG91bGQgbm90IG11dGF0ZSBwcm9jZXNzLmN3ZFwiKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwiUzAxLVNVTU1BUlkubWRcIikpLFxuICAgICAgICBcInN1bW1hcnkgZmlsZSBzaG91bGQgZXhpc3Qgb24gZGlza1wiLFxuICAgICAgKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwiZ3NkX2V4ZWMgcnVucyBieSBkZWZhdWx0LCBwcmVzZXJ2ZXMgY3dkLCBhbmQgcmV0dXJucyBzdHJ1Y3R1cmVkIG1ldGFkYXRhXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICBjb25zdCBvcmlnaW5hbEN3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHNlcnZlciA9IG1ha2VNb2NrU2VydmVyKCk7XG4gICAgICByZWdpc3RlcldvcmtmbG93VG9vbHMoc2VydmVyIGFzIGFueSk7XG4gICAgICBjb25zdCB0b29sID0gc2VydmVyLnRvb2xzLmZpbmQoKHQpID0+IHQubmFtZSA9PT0gXCJnc2RfZXhlY1wiKTtcbiAgICAgIGFzc2VydC5vayh0b29sLCBcImV4ZWMgdG9vbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdG9vbCEuaGFuZGxlcih7XG4gICAgICAgIHByb2plY3REaXI6IGJhc2UsXG4gICAgICAgIHJ1bnRpbWU6IFwibm9kZVwiLFxuICAgICAgICBzY3JpcHQ6IFwiY29uc29sZS5sb2cocHJvY2Vzcy5jd2QoKSk7IGNvbnNvbGUubG9nKCdjb250ZXh0IG1vZGUgZGVmYXVsdCBvbicpO1wiLFxuICAgICAgICBwdXJwb3NlOiBcImRlZmF1bHQtb24gc21va2VcIixcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCByZWNvcmQgPSByZXN1bHQgYXMgYW55O1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlY29yZC5pc0Vycm9yLCBmYWxzZSk7XG4gICAgICBhc3NlcnQubWF0Y2gocmVjb3JkLmNvbnRlbnRbMF0udGV4dCBhcyBzdHJpbmcsIC9jb250ZXh0IG1vZGUgZGVmYXVsdCBvbi8pO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlY29yZC5zdHJ1Y3R1cmVkQ29udGVudC5vcGVyYXRpb24sIFwiZ3NkX2V4ZWNcIik7XG4gICAgICBhc3NlcnQuZXF1YWwocmVjb3JkLnN0cnVjdHVyZWRDb250ZW50LnJ1bnRpbWUsIFwibm9kZVwiKTtcbiAgICAgIGFzc2VydC5vayhleGlzdHNTeW5jKHJlY29yZC5zdHJ1Y3R1cmVkQ29udGVudC5zdGRvdXRfcGF0aCksIFwic3Rkb3V0IHNob3VsZCBiZSBwZXJzaXN0ZWRcIik7XG4gICAgICBhc3NlcnQuZXF1YWwocHJvY2Vzcy5jd2QoKSwgb3JpZ2luYWxDd2QsIFwiZ3NkX2V4ZWMgbXVzdCBub3QgbXV0YXRlIHByb2Nlc3MuY3dkXCIpO1xuICAgICAgYXNzZXJ0Lm1hdGNoKFxuICAgICAgICByZWFkRmlsZVN5bmMocmVjb3JkLnN0cnVjdHVyZWRDb250ZW50LnN0ZG91dF9wYXRoLCBcInV0Zi04XCIpLFxuICAgICAgICBuZXcgUmVnRXhwKGJhc2UucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xcXVxcXFxdL2csIFwiXFxcXCQmXCIpKSxcbiAgICAgICAgXCJzY3JpcHQgc2hvdWxkIHJ1biByZWxhdGl2ZSB0byB0aGUgcmVxdWVzdGVkIHByb2plY3REaXJcIixcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICBpdChcImdzZF9leGVjIHJldHVybnMgYW4gTUNQIGVycm9yIHdoZW4gY29udGV4dCBtb2RlIGlzIGRpc2FibGVkXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlU3luYyhcbiAgICAgICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSxcbiAgICAgICAgXCItLS1cXG5jb250ZXh0X21vZGU6XFxuICBlbmFibGVkOiBmYWxzZVxcbi0tLVxcblwiLFxuICAgICAgICBcInV0Zi04XCIsXG4gICAgICApO1xuICAgICAgY29uc3Qgc2VydmVyID0gbWFrZU1vY2tTZXJ2ZXIoKTtcbiAgICAgIHJlZ2lzdGVyV29ya2Zsb3dUb29scyhzZXJ2ZXIgYXMgYW55KTtcbiAgICAgIGNvbnN0IHRvb2wgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF9leGVjXCIpO1xuICAgICAgYXNzZXJ0Lm9rKHRvb2wsIFwiZXhlYyB0b29sIHNob3VsZCBiZSByZWdpc3RlcmVkXCIpO1xuXG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0b29sIS5oYW5kbGVyKHtcbiAgICAgICAgcHJvamVjdERpcjogYmFzZSxcbiAgICAgICAgcnVudGltZTogXCJiYXNoXCIsXG4gICAgICAgIHNjcmlwdDogXCJlY2hvIHNob3VsZC1ub3QtcnVuXCIsXG4gICAgICB9KTtcblxuICAgICAgYXNzZXJ0VG9vbEVycm9yKHJlc3VsdCwgL2NvbnRleHRfbW9kZVxcLmVuYWJsZWQ6IGZhbHNlLyk7XG4gICAgICBhc3NlcnQuZXF1YWwoKHJlc3VsdCBhcyBhbnkpLnN0cnVjdHVyZWRDb250ZW50LmVycm9yLCBcImNvbnRleHRfbW9kZV9kaXNhYmxlZFwiKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwiZ3NkX2V4ZWMgaXMgYmxvY2tlZCBieSB0aGUgTUNQIGRpc2N1c3Npb24tZ2F0ZSB3cml0ZSBnYXRlXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVXcml0ZUdhdGVTbmFwc2hvdChiYXNlLCB7IHBlbmRpbmdHYXRlSWQ6IFwiZGVwdGhfdmVyaWZpY2F0aW9uX00wMDFfY29uZmlybVwiIH0pO1xuICAgICAgY29uc3Qgc2VydmVyID0gbWFrZU1vY2tTZXJ2ZXIoKTtcbiAgICAgIHJlZ2lzdGVyV29ya2Zsb3dUb29scyhzZXJ2ZXIgYXMgYW55KTtcbiAgICAgIGNvbnN0IHRvb2wgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF9leGVjXCIpO1xuICAgICAgYXNzZXJ0Lm9rKHRvb2wsIFwiZXhlYyB0b29sIHNob3VsZCBiZSByZWdpc3RlcmVkXCIpO1xuXG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0b29sIS5oYW5kbGVyKHtcbiAgICAgICAgcHJvamVjdERpcjogYmFzZSxcbiAgICAgICAgcnVudGltZTogXCJiYXNoXCIsXG4gICAgICAgIHNjcmlwdDogXCJlY2hvIHNob3VsZC1ub3QtcnVuXCIsXG4gICAgICB9KTtcblxuICAgICAgYXNzZXJ0VG9vbEVycm9yKHJlc3VsdCwgL0Rpc2N1c3Npb24gZ2F0ZSAuKiBoYXMgbm90IGJlZW4gY29uZmlybWVkLyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICBpdChcImdzZF9leGVjX3NlYXJjaCBmaW5kcyBhIHByaW9yIGdzZF9leGVjIHJ1blwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHNlcnZlciA9IG1ha2VNb2NrU2VydmVyKCk7XG4gICAgICByZWdpc3RlcldvcmtmbG93VG9vbHMoc2VydmVyIGFzIGFueSk7XG4gICAgICBjb25zdCBleGVjVG9vbCA9IHNlcnZlci50b29scy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09IFwiZ3NkX2V4ZWNcIik7XG4gICAgICBjb25zdCBzZWFyY2hUb29sID0gc2VydmVyLnRvb2xzLmZpbmQoKHQpID0+IHQubmFtZSA9PT0gXCJnc2RfZXhlY19zZWFyY2hcIik7XG4gICAgICBhc3NlcnQub2soZXhlY1Rvb2wsIFwiZXhlYyB0b29sIHNob3VsZCBiZSByZWdpc3RlcmVkXCIpO1xuICAgICAgYXNzZXJ0Lm9rKHNlYXJjaFRvb2wsIFwiZXhlYyBzZWFyY2ggdG9vbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcblxuICAgICAgYXdhaXQgZXhlY1Rvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBydW50aW1lOiBcImJhc2hcIixcbiAgICAgICAgc2NyaXB0OiBcInByaW50ZiAnbmVlZGxlLW91dHB1dFxcXFxuJ1wiLFxuICAgICAgICBwdXJwb3NlOiBcImZpbmQtbWUtbGF0ZXJcIixcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBzZWFyY2hUb29sIS5oYW5kbGVyKHtcbiAgICAgICAgcHJvamVjdERpcjogYmFzZSxcbiAgICAgICAgcXVlcnk6IFwiZmluZC1tZVwiLFxuICAgICAgfSk7XG5cbiAgICAgIGFzc2VydC5tYXRjaCgocmVzdWx0IGFzIGFueSkuY29udGVudFswXS50ZXh0IGFzIHN0cmluZywgL2ZpbmQtbWUtbGF0ZXIvKTtcbiAgICAgIGFzc2VydC5lcXVhbCgocmVzdWx0IGFzIGFueSkuc3RydWN0dXJlZENvbnRlbnQub3BlcmF0aW9uLCBcImdzZF9leGVjX3NlYXJjaFwiKTtcbiAgICAgIGFzc2VydC5lcXVhbCgocmVzdWx0IGFzIGFueSkuc3RydWN0dXJlZENvbnRlbnQubWF0Y2hlcywgMSk7XG4gICAgICBhc3NlcnQubWF0Y2goKHJlc3VsdCBhcyBhbnkpLnN0cnVjdHVyZWRDb250ZW50LnJlc3VsdHNbMF0uc3Rkb3V0X3BhdGgsIC9cXC5nc2RbXFxcXC9dZXhlY1tcXFxcL10uKlxcLnN0ZG91dCQvKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwiZ3NkX2V4ZWNfc2VhcmNoIHJldHVybnMgYW4gTUNQIGVycm9yIHdoZW4gY29udGV4dCBtb2RlIGlzIGRpc2FibGVkXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlU3luYyhcbiAgICAgICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSxcbiAgICAgICAgXCItLS1cXG5jb250ZXh0X21vZGU6XFxuICBlbmFibGVkOiBmYWxzZVxcbi0tLVxcblwiLFxuICAgICAgICBcInV0Zi04XCIsXG4gICAgICApO1xuICAgICAgY29uc3Qgc2VydmVyID0gbWFrZU1vY2tTZXJ2ZXIoKTtcbiAgICAgIHJlZ2lzdGVyV29ya2Zsb3dUb29scyhzZXJ2ZXIgYXMgYW55KTtcbiAgICAgIGNvbnN0IHRvb2wgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF9leGVjX3NlYXJjaFwiKTtcbiAgICAgIGFzc2VydC5vayh0b29sLCBcImV4ZWMgc2VhcmNoIHRvb2wgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRvb2whLmhhbmRsZXIoeyBwcm9qZWN0RGlyOiBiYXNlLCBxdWVyeTogXCJhbnl0aGluZ1wiIH0pO1xuXG4gICAgICBhc3NlcnRUb29sRXJyb3IocmVzdWx0LCAvY29udGV4dF9tb2RlXFwuZW5hYmxlZDogZmFsc2UvKTtcbiAgICAgIGFzc2VydC5lcXVhbCgocmVzdWx0IGFzIGFueSkuc3RydWN0dXJlZENvbnRlbnQuZXJyb3IsIFwiY29udGV4dF9tb2RlX2Rpc2FibGVkXCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoXCJnc2RfcmVzdW1lIHJlYWRzIHRoZSBjb250ZXh0IHNuYXBzaG90XCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlU3luYyhcbiAgICAgICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJsYXN0LXNuYXBzaG90Lm1kXCIpLFxuICAgICAgICBcIiMgR1NEIGNvbnRleHQgc25hcHNob3RcXG5cXG5SZXN1bWUgZnJvbSBoZXJlLlxcblwiLFxuICAgICAgICBcInV0Zi04XCIsXG4gICAgICApO1xuICAgICAgY29uc3Qgc2VydmVyID0gbWFrZU1vY2tTZXJ2ZXIoKTtcbiAgICAgIHJlZ2lzdGVyV29ya2Zsb3dUb29scyhzZXJ2ZXIgYXMgYW55KTtcbiAgICAgIGNvbnN0IHRvb2wgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF9yZXN1bWVcIik7XG4gICAgICBhc3NlcnQub2sodG9vbCwgXCJyZXN1bWUgdG9vbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdG9vbCEuaGFuZGxlcih7IHByb2plY3REaXI6IGJhc2UgfSk7XG5cbiAgICAgIGFzc2VydC5tYXRjaCgocmVzdWx0IGFzIGFueSkuY29udGVudFswXS50ZXh0IGFzIHN0cmluZywgL1Jlc3VtZSBmcm9tIGhlcmUvKTtcbiAgICAgIGFzc2VydC5kZWVwRXF1YWwoKHJlc3VsdCBhcyBhbnkpLnN0cnVjdHVyZWRDb250ZW50LCB7XG4gICAgICAgIG9wZXJhdGlvbjogXCJnc2RfcmVzdW1lXCIsXG4gICAgICAgIGZvdW5kOiB0cnVlLFxuICAgICAgICBieXRlczogQnVmZmVyLmJ5dGVMZW5ndGgoXCIjIEdTRCBjb250ZXh0IHNuYXBzaG90XFxuXFxuUmVzdW1lIGZyb20gaGVyZS5cXG5cIiwgXCJ1dGYtOFwiKSxcbiAgICAgIH0pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoXCJnc2RfcmVzdW1lIHJldHVybnMgYW4gTUNQIGVycm9yIHdoZW4gY29udGV4dCBtb2RlIGlzIGRpc2FibGVkXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlU3luYyhcbiAgICAgICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSxcbiAgICAgICAgXCItLS1cXG5jb250ZXh0X21vZGU6XFxuICBlbmFibGVkOiBmYWxzZVxcbi0tLVxcblwiLFxuICAgICAgICBcInV0Zi04XCIsXG4gICAgICApO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcImxhc3Qtc25hcHNob3QubWRcIiksIFwiIyBHU0QgY29udGV4dCBzbmFwc2hvdFxcblxcbkhpZGRlbi5cXG5cIiwgXCJ1dGYtOFwiKTtcbiAgICAgIGNvbnN0IHNlcnZlciA9IG1ha2VNb2NrU2VydmVyKCk7XG4gICAgICByZWdpc3RlcldvcmtmbG93VG9vbHMoc2VydmVyIGFzIGFueSk7XG4gICAgICBjb25zdCB0b29sID0gc2VydmVyLnRvb2xzLmZpbmQoKHQpID0+IHQubmFtZSA9PT0gXCJnc2RfcmVzdW1lXCIpO1xuICAgICAgYXNzZXJ0Lm9rKHRvb2wsIFwicmVzdW1lIHRvb2wgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRvb2whLmhhbmRsZXIoeyBwcm9qZWN0RGlyOiBiYXNlIH0pO1xuXG4gICAgICBhc3NlcnRUb29sRXJyb3IocmVzdWx0LCAvY29udGV4dF9tb2RlXFwuZW5hYmxlZDogZmFsc2UvKTtcbiAgICAgIGFzc2VydC5lcXVhbCgocmVzdWx0IGFzIGFueSkuc3RydWN0dXJlZENvbnRlbnQuZXJyb3IsIFwiY29udGV4dF9tb2RlX2Rpc2FibGVkXCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoXCJnc2Rfc3VtbWFyeV9zYXZlIHN1cHBvcnRzIHJvb3QtbGV2ZWwgUFJPSkVDVCBhcnRpZmFjdHMgd2l0aG91dCBtaWxlc3RvbmVfaWRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzZXJ2ZXIgPSBtYWtlTW9ja1NlcnZlcigpO1xuICAgICAgcmVnaXN0ZXJXb3JrZmxvd1Rvb2xzKHNlcnZlciBhcyBhbnkpO1xuICAgICAgY29uc3QgdG9vbCA9IHNlcnZlci50b29scy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09IFwiZ3NkX3N1bW1hcnlfc2F2ZVwiKTtcbiAgICAgIGFzc2VydC5vayh0b29sLCBcInN1bW1hcnkgdG9vbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcblxuICAgICAgY29uc3QgbWlsZXN0b25lUGFyYW0gPSB0b29sIS5wYXJhbXMubWlsZXN0b25lX2lkIGFzIHsgaXNPcHRpb25hbD86ICgpID0+IGJvb2xlYW4gfTtcbiAgICAgIGFzc2VydC5lcXVhbChcbiAgICAgICAgbWlsZXN0b25lUGFyYW0uaXNPcHRpb25hbD8uKCksXG4gICAgICAgIHRydWUsXG4gICAgICAgIFwid29ya2Zsb3cgTUNQIHNjaGVtYSBtdXN0IGFkdmVydGlzZSBtaWxlc3RvbmVfaWQgYXMgb3B0aW9uYWwgZm9yIHJvb3QgYXJ0aWZhY3RzXCIsXG4gICAgICApO1xuXG4gICAgICBjb25zdCBwcm9qZWN0Rml4dHVyZSA9IFtcbiAgICAgICAgXCIjIFByb2plY3RcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCJSb290IGFydGlmYWN0XCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyMgTWlsZXN0b25lIFNlcXVlbmNlXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiLSBbIF0gTTAwMTogRm91bmRhdGlvbiAtIEVzdGFibGlzaCB0aGUgZmlyc3QgcnVubmFibGUgc2xpY2UuXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIik7XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBhcnRpZmFjdF90eXBlOiBcIlBST0pFQ1RcIixcbiAgICAgICAgY29udGVudDogcHJvamVjdEZpeHR1cmUsXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgdGV4dCA9IChyZXN1bHQgYXMgYW55KS5jb250ZW50WzBdLnRleHQgYXMgc3RyaW5nO1xuICAgICAgYXNzZXJ0Lm1hdGNoKHRleHQsIC9TYXZlZCBQUk9KRUNUIGFydGlmYWN0Lyk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIGV4aXN0c1N5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJQUk9KRUNULm1kXCIpKSxcbiAgICAgICAgXCJyb290IHByb2plY3QgYXJ0aWZhY3Qgc2hvdWxkIGV4aXN0IG9uIGRpc2tcIixcbiAgICAgICk7XG4gICAgICBhc3NlcnQuZXF1YWwoXG4gICAgICAgIHJlYWRGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBST0pFQ1QubWRcIiksIFwidXRmLThcIiksXG4gICAgICAgIHByb2plY3RGaXh0dXJlLFxuICAgICAgKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwiZ3NkX3N1bW1hcnlfc2F2ZSByZWplY3RzIG1pbGVzdG9uZS1zY29wZWQgYXJ0aWZhY3RzIHdpdGhvdXQgbWlsZXN0b25lX2lkXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc2VydmVyID0gbWFrZU1vY2tTZXJ2ZXIoKTtcbiAgICAgIHJlZ2lzdGVyV29ya2Zsb3dUb29scyhzZXJ2ZXIgYXMgYW55KTtcbiAgICAgIGNvbnN0IHRvb2wgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF9zdW1tYXJ5X3NhdmVcIik7XG4gICAgICBhc3NlcnQub2sodG9vbCwgXCJzdW1tYXJ5IHRvb2wgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBhcnRpZmFjdF90eXBlOiBcIlNVTU1BUllcIixcbiAgICAgICAgY29udGVudDogXCIjIFN1bW1hcnlcXG5cIixcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCB0ZXh0ID0gKHJlc3VsdCBhcyBhbnkpLmNvbnRlbnQ/LlswXT8udGV4dCBhcyBzdHJpbmc7XG4gICAgICBhc3NlcnQubWF0Y2goXG4gICAgICAgIHRleHQsXG4gICAgICAgIC9taWxlc3RvbmVfaWQgaXMgcmVxdWlyZWQgZm9yIG1pbGVzdG9uZS1zY29wZWQgYXJ0aWZhY3QgdHlwZXMvLFxuICAgICAgKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwiZ3NkX3N1bW1hcnlfc2F2ZSByZW5kZXJzIHJvb3QgUkVRVUlSRU1FTlRTIGZyb20gREIgcm93cywgbm90IHByb3ZpZGVkIG1hcmtkb3duXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc2VydmVyID0gbWFrZU1vY2tTZXJ2ZXIoKTtcbiAgICAgIHJlZ2lzdGVyV29ya2Zsb3dUb29scyhzZXJ2ZXIgYXMgYW55KTtcbiAgICAgIGNvbnN0IHJlcXVpcmVtZW50VG9vbCA9IHNlcnZlci50b29scy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09IFwiZ3NkX3JlcXVpcmVtZW50X3NhdmVcIik7XG4gICAgICBjb25zdCBzdW1tYXJ5VG9vbCA9IHNlcnZlci50b29scy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09IFwiZ3NkX3N1bW1hcnlfc2F2ZVwiKTtcbiAgICAgIGFzc2VydC5vayhyZXF1aXJlbWVudFRvb2wsIFwicmVxdWlyZW1lbnQgdG9vbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcbiAgICAgIGFzc2VydC5vayhzdW1tYXJ5VG9vbCwgXCJzdW1tYXJ5IHRvb2wgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG5cbiAgICAgIGF3YWl0IHJlcXVpcmVtZW50VG9vbCEuaGFuZGxlcih7XG4gICAgICAgIHByb2plY3REaXI6IGJhc2UsXG4gICAgICAgIGNsYXNzOiBcInByaW1hcnktdXNlci1sb29wXCIsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBcIk1DUCB1c2VyIGNhbiBhZGQgYSB0YXNrXCIsXG4gICAgICAgIHdoeTogXCJDb3JlIGxvb3BcIixcbiAgICAgICAgc291cmNlOiBcInVzZXJcIixcbiAgICAgICAgc3RhdHVzOiBcImFjdGl2ZVwiLFxuICAgICAgICBwcmltYXJ5X293bmVyOiBcIk0wMDEvbm9uZSB5ZXRcIixcbiAgICAgICAgc3VwcG9ydGluZ19zbGljZXM6IFwibm9uZVwiLFxuICAgICAgICB2YWxpZGF0aW9uOiBcInVubWFwcGVkXCIsXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgc3VtbWFyeVRvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBhcnRpZmFjdF90eXBlOiBcIlJFUVVJUkVNRU5UU1wiLFxuICAgICAgICBjb250ZW50OiBcIiMgUmVxdWlyZW1lbnRzXFxuXFxuIyMgQWN0aXZlXFxuXFxuIyMjIFI5OTkgXHUyMDE0IFdyb25nIG1hcmtkb3duIHNvdXJjZVxcblxcbi0gRGVzY3JpcHRpb246IFRoaXMgY29udGVudCBtdXN0IG5vdCBiZWNvbWUgY2Fub25pY2FsLlxcblwiLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IHRleHQgPSAocmVzdWx0IGFzIGFueSkuY29udGVudFswXS50ZXh0IGFzIHN0cmluZztcbiAgICAgIGFzc2VydC5tYXRjaCh0ZXh0LCAvU2F2ZWQgUkVRVUlSRU1FTlRTIGFydGlmYWN0Lyk7XG5cbiAgICAgIGNvbnN0IHJlcXVpcmVtZW50c1BhdGggPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlJFUVVJUkVNRU5UUy5tZFwiKTtcbiAgICAgIGNvbnN0IG1hcmtkb3duID0gcmVhZEZpbGVTeW5jKHJlcXVpcmVtZW50c1BhdGgsIFwidXRmLThcIik7XG4gICAgICBhc3NlcnQubWF0Y2gobWFya2Rvd24sIC9NQ1AgdXNlciBjYW4gYWRkIGEgdGFzay8pO1xuICAgICAgYXNzZXJ0LmRvZXNOb3RNYXRjaChtYXJrZG93biwgL1I5OTl8V3JvbmcgbWFya2Rvd24gc291cmNlfFRoaXMgY29udGVudCBtdXN0IG5vdCBiZWNvbWUgY2Fub25pY2FsLyk7XG5cbiAgICAgIGNvbnN0IHJvdyA9IF9nZXRBZGFwdGVyKCkhXG4gICAgICAgIC5wcmVwYXJlKFwiU0VMRUNUIGlkLCBkZXNjcmlwdGlvbiBGUk9NIHJlcXVpcmVtZW50cyBXSEVSRSBkZXNjcmlwdGlvbiA9ID9cIilcbiAgICAgICAgLmdldChcIk1DUCB1c2VyIGNhbiBhZGQgYSB0YXNrXCIpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICAgICAgYXNzZXJ0Lm9rKHJvdywgXCJyZXF1aXJlbWVudCByb3cgc2hvdWxkIHJlbWFpbiB0aGUgY2Fub25pY2FsIHNvdXJjZVwiKTtcblxuICAgICAgY29uc3QgYXJ0aWZhY3QgPSBfZ2V0QWRhcHRlcigpIVxuICAgICAgICAucHJlcGFyZShcIlNFTEVDVCBmdWxsX2NvbnRlbnQgRlJPTSBhcnRpZmFjdHMgV0hFUkUgcGF0aCA9ID9cIilcbiAgICAgICAgLmdldChcIlJFUVVJUkVNRU5UUy5tZFwiKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgICAgIGFzc2VydC5lcXVhbChhcnRpZmFjdD8uZnVsbF9jb250ZW50LCBtYXJrZG93bik7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICBpdChcInJlamVjdHMgd29ya2Zsb3cgdG9vbCBjYWxscyBvdXRzaWRlIHRoZSBjb25maWd1cmVkIHByb2plY3Qgcm9vdFwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gICAgY29uc3Qgb3RoZXJCYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICBjb25zdCBwcmV2Um9vdCA9IHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QUk9KRUNUX1JPT1Q7XG4gICAgdHJ5IHtcbiAgICAgIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QUk9KRUNUX1JPT1QgPSBiYXNlO1xuICAgICAgY29uc3Qgc2VydmVyID0gbWFrZU1vY2tTZXJ2ZXIoKTtcbiAgICAgIHJlZ2lzdGVyV29ya2Zsb3dUb29scyhzZXJ2ZXIgYXMgYW55KTtcbiAgICAgIGNvbnN0IHRvb2wgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF9zdW1tYXJ5X3NhdmVcIik7XG4gICAgICBhc3NlcnQub2sodG9vbCwgXCJzdW1tYXJ5IHRvb2wgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBvdGhlckJhc2UsXG4gICAgICAgIG1pbGVzdG9uZV9pZDogXCJNMDAxXCIsXG4gICAgICAgIGFydGlmYWN0X3R5cGU6IFwiU1VNTUFSWVwiLFxuICAgICAgICBjb250ZW50OiBcIiMgU3VtbWFyeVwiLFxuICAgICAgfSk7XG4gICAgICBhc3NlcnRUb29sRXJyb3IocmVzdWx0LCAvY29uZmlndXJlZCB3b3JrZmxvdyBwcm9qZWN0IHJvb3QvKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgaWYgKHByZXZSb290ID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QUk9KRUNUX1JPT1Q7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUFJPSkVDVF9ST09UID0gcHJldlJvb3Q7XG4gICAgICB9XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgICAgY2xlYW51cChvdGhlckJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoXCJyZWplY3RzIG5vbi1maWxlIGV4ZWN1dG9yIG1vZHVsZSBVUkxzXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICBjb25zdCBwcmV2TW9kdWxlID0gcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX0VYRUNVVE9SU19NT0RVTEU7XG4gICAgY29uc3QgcHJldlJvb3QgPSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUFJPSkVDVF9ST09UO1xuICAgIHRyeSB7XG4gICAgICBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUFJPSkVDVF9ST09UID0gYmFzZTtcbiAgICAgIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19FWEVDVVRPUlNfTU9EVUxFID0gXCJkYXRhOnRleHQvamF2YXNjcmlwdCxleHBvcnQgZGVmYXVsdCB7fVwiO1xuICAgICAgY29uc3QgeyByZWdpc3RlcldvcmtmbG93VG9vbHM6IGZyZXNoUmVnaXN0ZXJXb3JrZmxvd1Rvb2xzIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgIGNhY2hlQnVzdGVkV29ya2Zsb3dUb29sc0ltcG9ydChcImJhZC1tb2R1bGVcIilcbiAgICAgICk7XG4gICAgICBjb25zdCBzZXJ2ZXIgPSBtYWtlTW9ja1NlcnZlcigpO1xuICAgICAgZnJlc2hSZWdpc3RlcldvcmtmbG93VG9vbHMoc2VydmVyIGFzIGFueSk7XG4gICAgICBjb25zdCB0b29sID0gc2VydmVyLnRvb2xzLmZpbmQoKHQpID0+IHQubmFtZSA9PT0gXCJnc2Rfc3VtbWFyeV9zYXZlXCIpO1xuICAgICAgYXNzZXJ0Lm9rKHRvb2wsIFwic3VtbWFyeSB0b29sIHNob3VsZCBiZSByZWdpc3RlcmVkXCIpO1xuXG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0b29sIS5oYW5kbGVyKHtcbiAgICAgICAgcHJvamVjdERpcjogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lX2lkOiBcIk0wMDFcIixcbiAgICAgICAgYXJ0aWZhY3RfdHlwZTogXCJTVU1NQVJZXCIsXG4gICAgICAgIGNvbnRlbnQ6IFwiIyBTdW1tYXJ5XCIsXG4gICAgICB9KTtcbiAgICAgIGFzc2VydFRvb2xFcnJvcihyZXN1bHQsIC9vbmx5IHN1cHBvcnRzIGZpbGU6IFVSTHMgb3IgZmlsZXN5c3RlbSBwYXRocy8pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBpZiAocHJldk1vZHVsZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfRVhFQ1VUT1JTX01PRFVMRTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19FWEVDVVRPUlNfTU9EVUxFID0gcHJldk1vZHVsZTtcbiAgICAgIH1cbiAgICAgIGlmIChwcmV2Um9vdCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUFJPSkVDVF9ST09UO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX1BST0pFQ1RfUk9PVCA9IHByZXZSb290O1xuICAgICAgfVxuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwiYmxvY2tzIHdvcmtmbG93IG11dGF0aW9uIHRvb2xzIHdoaWxlIGEgZGlzY3Vzc2lvbiBnYXRlIGlzIHBlbmRpbmdcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwiUzAxLVBMQU4ubWRcIiksXG4gICAgICAgIFwiIyBTMDFcXG5cXG4tIFsgXSAqKlQwMTogRGVtbyoqIGBlc3Q6NW1gXFxuXCIsXG4gICAgICApO1xuICAgICAgd3JpdGVXcml0ZUdhdGVTbmFwc2hvdChiYXNlLCB7IHBlbmRpbmdHYXRlSWQ6IFwiZGVwdGhfdmVyaWZpY2F0aW9uX00wMDFfY29uZmlybVwiIH0pO1xuXG4gICAgICBjb25zdCBzZXJ2ZXIgPSBtYWtlTW9ja1NlcnZlcigpO1xuICAgICAgcmVnaXN0ZXJXb3JrZmxvd1Rvb2xzKHNlcnZlciBhcyBhbnkpO1xuICAgICAgY29uc3QgdGFza1Rvb2wgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF90YXNrX2NvbXBsZXRlXCIpO1xuICAgICAgYXNzZXJ0Lm9rKHRhc2tUb29sLCBcInRhc2sgdG9vbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGFza1Rvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICB0YXNrSWQ6IFwiVDAxXCIsXG4gICAgICAgIHNsaWNlSWQ6IFwiUzAxXCIsXG4gICAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgICAgb25lTGluZXI6IFwiQ29tcGxldGVkIHRhc2tcIixcbiAgICAgICAgbmFycmF0aXZlOiBcIkRpZCB0aGUgd29ya1wiLFxuICAgICAgICB2ZXJpZmljYXRpb246IFwibnBtIHRlc3RcIixcbiAgICAgIH0pO1xuICAgICAgYXNzZXJ0VG9vbEVycm9yKHJlc3VsdCwgL0Rpc2N1c3Npb24gZ2F0ZSAuKiBoYXMgbm90IGJlZW4gY29uZmlybWVkLyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICBpdChcImJsb2NrcyB3b3JrZmxvdyBtdXRhdGlvbiB0b29scyBkdXJpbmcgcXVldWUgbW9kZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJTMDEtUExBTi5tZFwiKSxcbiAgICAgICAgXCIjIFMwMVxcblxcbi0gWyBdICoqVDAxOiBEZW1vKiogYGVzdDo1bWBcXG5cIixcbiAgICAgICk7XG4gICAgICB3cml0ZVdyaXRlR2F0ZVNuYXBzaG90KGJhc2UsIHsgYWN0aXZlUXVldWVQaGFzZTogdHJ1ZSB9KTtcblxuICAgICAgY29uc3Qgc2VydmVyID0gbWFrZU1vY2tTZXJ2ZXIoKTtcbiAgICAgIHJlZ2lzdGVyV29ya2Zsb3dUb29scyhzZXJ2ZXIgYXMgYW55KTtcbiAgICAgIGNvbnN0IHRhc2tUb29sID0gc2VydmVyLnRvb2xzLmZpbmQoKHQpID0+IHQubmFtZSA9PT0gXCJnc2RfdGFza19jb21wbGV0ZVwiKTtcbiAgICAgIGFzc2VydC5vayh0YXNrVG9vbCwgXCJ0YXNrIHRvb2wgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRhc2tUb29sIS5oYW5kbGVyKHtcbiAgICAgICAgcHJvamVjdERpcjogYmFzZSxcbiAgICAgICAgdGFza0lkOiBcIlQwMVwiLFxuICAgICAgICBzbGljZUlkOiBcIlMwMVwiLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIG9uZUxpbmVyOiBcIkNvbXBsZXRlZCB0YXNrXCIsXG4gICAgICAgIG5hcnJhdGl2ZTogXCJEaWQgdGhlIHdvcmtcIixcbiAgICAgICAgdmVyaWZpY2F0aW9uOiBcIm5wbSB0ZXN0XCIsXG4gICAgICB9KTtcbiAgICAgIGFzc2VydFRvb2xFcnJvcihyZXN1bHQsIC9wbGFubmluZyB0b29sIC4qIG5vdCBleGVjdXRlcyB3b3JrfENhbm5vdCBnc2RfdGFza19jb21wbGV0ZXxVbmtub3duIHRvb2xzIGFyZSBub3QgcGVybWl0dGVkIGR1cmluZyBxdWV1ZSBtb2RlLyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICBpdChcImdzZF90YXNrX2NvbXBsZXRlIGFuZCBnc2RfbWlsZXN0b25lX3N0YXR1cyB3b3JrIGVuZC10by1lbmRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwiUzAxLVBMQU4ubWRcIiksXG4gICAgICAgIFwiIyBTMDFcXG5cXG4tIFsgXSAqKlQwMTogRGVtbyoqIGBlc3Q6NW1gXFxuXCIsXG4gICAgICApO1xuXG4gICAgICBjb25zdCBzZXJ2ZXIgPSBtYWtlTW9ja1NlcnZlcigpO1xuICAgICAgcmVnaXN0ZXJXb3JrZmxvd1Rvb2xzKHNlcnZlciBhcyBhbnkpO1xuICAgICAgY29uc3QgdGFza1Rvb2wgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF90YXNrX2NvbXBsZXRlXCIpO1xuICAgICAgY29uc3Qgc3RhdHVzVG9vbCA9IHNlcnZlci50b29scy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09IFwiZ3NkX21pbGVzdG9uZV9zdGF0dXNcIik7XG4gICAgICBhc3NlcnQub2sodGFza1Rvb2wsIFwidGFzayB0b29sIHNob3VsZCBiZSByZWdpc3RlcmVkXCIpO1xuICAgICAgYXNzZXJ0Lm9rKHN0YXR1c1Rvb2wsIFwic3RhdHVzIHRvb2wgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG5cbiAgICAgIGNvbnN0IHRhc2tSZXN1bHQgPSBhd2FpdCB0YXNrVG9vbCEuaGFuZGxlcih7XG4gICAgICAgIHByb2plY3REaXI6IGJhc2UsXG4gICAgICAgIHRhc2tJZDogXCJUMDFcIixcbiAgICAgICAgc2xpY2VJZDogXCJTMDFcIixcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICBvbmVMaW5lcjogXCJDb21wbGV0ZWQgdGFza1wiLFxuICAgICAgICBuYXJyYXRpdmU6IFwiRGlkIHRoZSB3b3JrXCIsXG4gICAgICAgIHZlcmlmaWNhdGlvbjogXCJucG0gdGVzdFwiLFxuICAgICAgfSk7XG5cbiAgICAgIGFzc2VydC5tYXRjaCgodGFza1Jlc3VsdCBhcyBhbnkpLmNvbnRlbnRbMF0udGV4dCBhcyBzdHJpbmcsIC9Db21wbGV0ZWQgdGFzayBUMDEvKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwidGFza3NcIiwgXCJUMDEtU1VNTUFSWS5tZFwiKSksXG4gICAgICAgIFwidGFzayBzdW1tYXJ5IHNob3VsZCBiZSB3cml0dGVuIHRvIGRpc2tcIixcbiAgICAgICk7XG5cbiAgICAgIGNvbnN0IHN0YXR1c1Jlc3VsdCA9IGF3YWl0IHN0YXR1c1Rvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UoKHN0YXR1c1Jlc3VsdCBhcyBhbnkpLmNvbnRlbnRbMF0udGV4dCBhcyBzdHJpbmcpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHBhcnNlZC5taWxlc3RvbmVJZCwgXCJNMDAxXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHBhcnNlZC5zbGljZUNvdW50LCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChwYXJzZWQuc2xpY2VzWzBdLmlkLCBcIlMwMVwiKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwiIzQ0NzcgZ3NkX3Rhc2tfY29tcGxldGUgZm9yd2FyZHMgZXZlcnkgc2NoZW1hIGZpZWxkIHRvIHRoZSBleGVjdXRvciAocmVncmVzc2lvbiBmb3IgZGVzdHJ1Y3R1cmUtcmVidWlsZCBidWcgY2xhc3MpXCIsIGFzeW5jICgpID0+IHtcbiAgICAvLyBMb2NrcyBpbiB0aGUgY2xhc3MtZml4IGZyb20gUFIgIzQ0NzcgcmV2aWV3OiBoYW5kbGVUYXNrQ29tcGxldGUgcHJldmlvdXNseVxuICAgIC8vIGRlc3RydWN0dXJlZCBhcmdzIGludG8gYSBoYW5kLWxpc3RlZCBzZXQgb2YgZmllbGRzIGFuZCByZWJ1aWx0IHRoZSBjYWxsXG4gICAgLy8gcGF5bG9hZCwgd2hpY2ggc2lsZW50bHkgZHJvcHBlZCBBRFItMDExJ3MgYGVzY2FsYXRpb25gIGZpZWxkIChhbmQgYW55XG4gICAgLy8gZnV0dXJlIHNjaGVtYSBmaWVsZCBhZGRlZCB3aXRob3V0IHVwZGF0aW5nIHRoZSByZWJ1aWxkKS4gVGhlIGZpeCBwYXNzZXNcbiAgICAvLyBgYXJnc2AgdGhyb3VnaCBkaXJlY3RseSwgbWF0Y2hpbmcgdGhlIHNwcmVhZCBwYXR0ZXJuIG9mIHNpYmxpbmdcbiAgICAvLyBoYW5kbGVycy4gVGhpcyB0ZXN0IHZlcmlmaWVzIHRoZSBjb250cmFjdCBieSBpbmplY3RpbmcgYSBtb2NrIGV4ZWN1dG9yXG4gICAgLy8gbW9kdWxlIHRoYXQgY2FwdHVyZXMgdGhlIGFyZ3MsIGNhbGxpbmcgZ3NkX3Rhc2tfY29tcGxldGUgd2l0aCBhblxuICAgIC8vIGBlc2NhbGF0aW9uYCBwYXlsb2FkLCBhbmQgYXNzZXJ0aW5nIHRoZSBmaWVsZCByZWFjaGVkIHRoZSBleGVjdXRvci5cbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICBjb25zdCBjYXB0dXJlUGF0aCA9IGpvaW4oYmFzZSwgXCJjYXB0dXJlZC1hcmdzLmpzb25cIik7XG4gICAgY29uc3QgbW9ja01vZHVsZVBhdGggPSBqb2luKGJhc2UsIFwibW9jay1leGVjdXRvcnMubWpzXCIpO1xuICAgIGNvbnN0IHByZXZNb2R1bGUgPSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfRVhFQ1VUT1JTX01PRFVMRTtcbiAgICBjb25zdCBwcmV2Q2FwdHVyZSA9IHByb2Nlc3MuZW52LkdTRF9URVNUX1RBU0tfQ09NUExFVEVfQ0FQVFVSRV9QQVRIO1xuICAgIHRyeSB7XG4gICAgICAvLyBNb2NrIG1vZHVsZTogaW1wbGVtZW50cyB0aGUgV29ya2Zsb3dUb29sRXhlY3V0b3JzIHNoYXBlLlxuICAgICAgLy8gZXhlY3V0ZVRhc2tDb21wbGV0ZSB3cml0ZXMgaXRzIHJlY2VpdmVkIGFyZ3MgdG8gZGlzayBmb3IgYXNzZXJ0aW9uLlxuICAgICAgLy8gT3RoZXIgZXhlY3V0b3JzIGFyZSBuby1vcCBzdHVicyB0byBzYXRpc2Z5IGlzV29ya2Zsb3dUb29sRXhlY3V0b3JzLlxuICAgICAgY29uc3QgbW9ja1NvdXJjZSA9IGBcbmltcG9ydCB7IHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuXG5jb25zdCBub29wID0gYXN5bmMgKCkgPT4gKHsgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwibm9vcFwiIH1dIH0pO1xuXG5leHBvcnQgY29uc3QgU1VQUE9SVEVEX1NVTU1BUllfQVJUSUZBQ1RfVFlQRVMgPSBbXCJTVU1NQVJZXCIsIFwiVUFUXCIsIFwiQ09OVEVYVFwiLCBcIlBMQU5cIl07XG5leHBvcnQgY29uc3QgZXhlY3V0ZU1pbGVzdG9uZVN0YXR1cyA9IG5vb3A7XG5leHBvcnQgY29uc3QgZXhlY3V0ZVBsYW5NaWxlc3RvbmUgPSBub29wO1xuZXhwb3J0IGNvbnN0IGV4ZWN1dGVQbGFuU2xpY2UgPSBub29wO1xuZXhwb3J0IGNvbnN0IGV4ZWN1dGVSZXBsYW5TbGljZSA9IG5vb3A7XG5leHBvcnQgY29uc3QgZXhlY3V0ZVNsaWNlQ29tcGxldGUgPSBub29wO1xuZXhwb3J0IGNvbnN0IGV4ZWN1dGVDb21wbGV0ZU1pbGVzdG9uZSA9IG5vb3A7XG5leHBvcnQgY29uc3QgZXhlY3V0ZVZhbGlkYXRlTWlsZXN0b25lID0gbm9vcDtcbmV4cG9ydCBjb25zdCBleGVjdXRlUmVhc3Nlc3NSb2FkbWFwID0gbm9vcDtcbmV4cG9ydCBjb25zdCBleGVjdXRlU2F2ZUdhdGVSZXN1bHQgPSBub29wO1xuZXhwb3J0IGNvbnN0IGV4ZWN1dGVTdW1tYXJ5U2F2ZSA9IG5vb3A7XG5leHBvcnQgY29uc3QgZXhlY3V0ZVRhc2tSZW9wZW4gPSBub29wO1xuZXhwb3J0IGNvbnN0IGV4ZWN1dGVTbGljZVJlb3BlbiA9IG5vb3A7XG5leHBvcnQgY29uc3QgZXhlY3V0ZU1pbGVzdG9uZVJlb3BlbiA9IG5vb3A7XG5cbmV4cG9ydCBjb25zdCBleGVjdXRlVGFza0NvbXBsZXRlID0gYXN5bmMgKHBhcmFtcywgcHJvamVjdERpcikgPT4ge1xuICBjb25zdCBjYXB0dXJlUGF0aCA9IHByb2Nlc3MuZW52LkdTRF9URVNUX1RBU0tfQ09NUExFVEVfQ0FQVFVSRV9QQVRIO1xuICBpZiAoY2FwdHVyZVBhdGgpIHtcbiAgICB3cml0ZUZpbGVTeW5jKGNhcHR1cmVQYXRoLCBKU09OLnN0cmluZ2lmeSh7IHBhcmFtcywgcHJvamVjdERpciB9LCBudWxsLCAyKSk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJtb2NrIHRhc2sgY29tcGxldGVcIiB9XSxcbiAgICBkZXRhaWxzOiB7IHRhc2tJZDogcGFyYW1zLnRhc2tJZCB9LFxuICB9O1xufTtcbmA7XG4gICAgICB3cml0ZUZpbGVTeW5jKG1vY2tNb2R1bGVQYXRoLCBtb2NrU291cmNlLCBcInV0Zi04XCIpO1xuICAgICAgcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX0VYRUNVVE9SU19NT0RVTEUgPSBtb2NrTW9kdWxlUGF0aDtcbiAgICAgIHByb2Nlc3MuZW52LkdTRF9URVNUX1RBU0tfQ09NUExFVEVfQ0FQVFVSRV9QQVRIID0gY2FwdHVyZVBhdGg7XG5cbiAgICAgIC8vIEZyZXNoIGltcG9ydCBieXBhc3NlcyB0aGUgY2FjaGVkIHdvcmtmbG93VG9vbEV4ZWN1dG9yc1Byb21pc2Ugc28gdGhlXG4gICAgICAvLyBtb2NrIG1vZHVsZSBpcyBhY3R1YWxseSBsb2FkZWQgZm9yIHRoaXMgdGVzdC5cbiAgICAgIGNvbnN0IHsgcmVnaXN0ZXJXb3JrZmxvd1Rvb2xzOiBmcmVzaFJlZ2lzdGVyV29ya2Zsb3dUb29scyB9ID0gYXdhaXQgaW1wb3J0KFxuICAgICAgICBjYWNoZUJ1c3RlZFdvcmtmbG93VG9vbHNJbXBvcnQoXCJlc2NhbGF0aW9uLXRlc3RcIilcbiAgICAgICk7XG4gICAgICBjb25zdCBzZXJ2ZXIgPSBtYWtlTW9ja1NlcnZlcigpO1xuICAgICAgZnJlc2hSZWdpc3RlcldvcmtmbG93VG9vbHMoc2VydmVyIGFzIGFueSk7XG4gICAgICBjb25zdCB0YXNrVG9vbCA9IHNlcnZlci50b29scy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09IFwiZ3NkX3Rhc2tfY29tcGxldGVcIik7XG4gICAgICBhc3NlcnQub2sodGFza1Rvb2wsIFwidGFzayB0b29sIHNob3VsZCBiZSByZWdpc3RlcmVkXCIpO1xuXG4gICAgICAvLyBNaXJyb3JzIHRoZSBBRFItMDExIGVzY2FsYXRpb24gc2NoZW1hOiBxdWVzdGlvbiArIDItNCBvcHRpb25zXG4gICAgICAvLyAoZWFjaCB3aXRoIGlkL2xhYmVsL3RyYWRlb2ZmcykgKyByZWNvbW1lbmRhdGlvbiArIHJhdGlvbmFsZSArXG4gICAgICAvLyBjb250aW51ZVdpdGhEZWZhdWx0IGZsYWcuXG4gICAgICBjb25zdCBlc2NhbGF0aW9uUGF5bG9hZCA9IHtcbiAgICAgICAgcXVlc3Rpb246IFwiU2hvdWxkIHRoZSBhdXRoIGZsb3cgdXNlIE9BdXRoIG9yIFBBVD9cIixcbiAgICAgICAgb3B0aW9uczogW1xuICAgICAgICAgIHsgaWQ6IFwiQVwiLCBsYWJlbDogXCJPQXV0aFwiLCB0cmFkZW9mZnM6IFwiQmVzdCBVWDsgcmVxdWlyZXMgbW9yZSBzZXR1cC5cIiB9LFxuICAgICAgICAgIHsgaWQ6IFwiQlwiLCBsYWJlbDogXCJQQVRcIiwgdHJhZGVvZmZzOiBcIlNpbXBsZXI7IHdlYWtlciByb3RhdGlvbiBzdG9yeS5cIiB9LFxuICAgICAgICBdLFxuICAgICAgICByZWNvbW1lbmRhdGlvbjogXCJBXCIsXG4gICAgICAgIHJlY29tbWVuZGF0aW9uUmF0aW9uYWxlOiBcIkluaXRpYWwgcmVxdWlyZW1lbnQgaW1wbGllZCBtdWx0aS11c2VyOyBPQXV0aCBmaXRzIGJldHRlci5cIixcbiAgICAgICAgY29udGludWVXaXRoRGVmYXVsdDogdHJ1ZSxcbiAgICAgIH07XG5cbiAgICAgIGF3YWl0IHRhc2tUb29sIS5oYW5kbGVyKHtcbiAgICAgICAgcHJvamVjdERpcjogYmFzZSxcbiAgICAgICAgdGFza0lkOiBcIlQwMVwiLFxuICAgICAgICBzbGljZUlkOiBcIlMwMVwiLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIG9uZUxpbmVyOiBcIkNvbXBsZXRlZCB0YXNrIHdpdGggZXNjYWxhdGlvblwiLFxuICAgICAgICBuYXJyYXRpdmU6IFwiRGlkIHRoZSB3b3JrIGJ1dCBmbGFnZ2VkIGFuIGFtYmlndWl0eVwiLFxuICAgICAgICB2ZXJpZmljYXRpb246IFwibnBtIHRlc3RcIixcbiAgICAgICAgZXNjYWxhdGlvbjogZXNjYWxhdGlvblBheWxvYWQsXG4gICAgICAgIHZlcmlmaWNhdGlvbkV2aWRlbmNlOiBbXG4gICAgICAgICAgeyBjb21tYW5kOiBcIm5wbSB0ZXN0XCIsIGV4aXRDb2RlOiAwLCB2ZXJkaWN0OiBcInBhc3NcIiwgZHVyYXRpb25NczogMTIzNCB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG5cbiAgICAgIGFzc2VydC5vayhleGlzdHNTeW5jKGNhcHR1cmVQYXRoKSwgXCJtb2NrIGV4ZWN1dG9yIHNob3VsZCBoYXZlIHdyaXR0ZW4gY2FwdHVyZWQgYXJncyB0byBkaXNrXCIpO1xuICAgICAgY29uc3QgY2FwdHVyZWQgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhjYXB0dXJlUGF0aCwgXCJ1dGYtOFwiKSk7XG5cbiAgICAgIC8vIFRoZSBoYW5kbGVyIHJlc29sdmVzIHByb2plY3REaXIgdmlhIHJlYWxwYXRoU3luYyAoc2VjdXJpdHkvc3ltbGluayBjaGVjayksXG4gICAgICAvLyBzbyBvbiBtYWNPUyB3aGVyZSAvdmFyIHN5bWxpbmtzIHRvIC9wcml2YXRlL3ZhciwgdGhlIGNhcHR1cmVkIHBhdGggd2lsbFxuICAgICAgLy8gYmUgdGhlIHJlYWxwYXRoIGZvcm0uIE5vcm1hbGl6ZSBib3RoIHNpZGVzLlxuICAgICAgYXNzZXJ0LmVxdWFsKGNhcHR1cmVkLnByb2plY3REaXIsIHJlYWxwYXRoU3luYyhiYXNlKSwgXCJwcm9qZWN0RGlyIHNob3VsZCBiZSBwYXNzZWQgYXMgc2Vjb25kIGFyZ1wiKTtcbiAgICAgIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgICAgIGNhcHR1cmVkLnBhcmFtcy5lc2NhbGF0aW9uLFxuICAgICAgICBlc2NhbGF0aW9uUGF5bG9hZCxcbiAgICAgICAgXCJlc2NhbGF0aW9uIHBheWxvYWQgbXVzdCByZWFjaCB0aGUgZXhlY3V0b3IgdmVyYmF0aW0gXHUyMDE0IHJlZ3Jlc3Npb24gZ3VhcmQgZm9yIHRoZSBkZXN0cnVjdHVyZS1yZWJ1aWxkIGJ1ZyBjbGFzcyAoIzQ0NzcgcmV2aWV3KVwiLFxuICAgICAgKTtcbiAgICAgIC8vIFNwb3QtY2hlY2sgYSBjb3VwbGUgb2Ygb3RoZXIgZmllbGRzIHRvIGVuc3VyZSB0aGUgc3ByZWFkIHBhdHRlcm5cbiAgICAgIC8vIGRvZXNuJ3QgYWNjaWRlbnRhbGx5IGV4Y2x1ZGUgdGhlIHJlc3Qgd2hpbGUgaW5jbHVkaW5nIGVzY2FsYXRpb24uXG4gICAgICBhc3NlcnQuZXF1YWwoY2FwdHVyZWQucGFyYW1zLnRhc2tJZCwgXCJUMDFcIiwgXCJ0YXNrSWQgbXVzdCBiZSBmb3J3YXJkZWRcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoY2FwdHVyZWQucGFyYW1zLm1pbGVzdG9uZUlkLCBcIk0wMDFcIiwgXCJtaWxlc3RvbmVJZCBtdXN0IGJlIGZvcndhcmRlZFwiKTtcbiAgICAgIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgICAgIGNhcHR1cmVkLnBhcmFtcy52ZXJpZmljYXRpb25FdmlkZW5jZSxcbiAgICAgICAgW3sgY29tbWFuZDogXCJucG0gdGVzdFwiLCBleGl0Q29kZTogMCwgdmVyZGljdDogXCJwYXNzXCIsIGR1cmF0aW9uTXM6IDEyMzQgfV0sXG4gICAgICAgIFwidmVyaWZpY2F0aW9uRXZpZGVuY2UgbXVzdCBiZSBmb3J3YXJkZWQgKGV4aXN0aW5nIGZpZWxkKVwiLFxuICAgICAgKTtcbiAgICAgIC8vIEVuc3VyZSBubyBwcm9qZWN0RGlyIGxlYWsgaW50byBwYXJhbXMgKGl0IHNob3VsZCBiZSB0aGUgc2Vjb25kIGFyZyBvbmx5KS5cbiAgICAgIGFzc2VydC5lcXVhbChcbiAgICAgICAgY2FwdHVyZWQucGFyYW1zLnByb2plY3REaXIsXG4gICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICAgXCJwcm9qZWN0RGlyIG11c3QgTk9UIGFwcGVhciBpbiBwYXJhbXMgXHUyMDE0IGl0J3Mgc3RyaXBwZWQgdmlhIHRoZSBzcHJlYWQgZGVzdHJ1Y3R1cmVcIixcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGlmIChwcmV2TW9kdWxlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19FWEVDVVRPUlNfTU9EVUxFO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX0VYRUNVVE9SU19NT0RVTEUgPSBwcmV2TW9kdWxlO1xuICAgICAgfVxuICAgICAgaWYgKHByZXZDYXB0dXJlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9URVNUX1RBU0tfQ09NUExFVEVfQ0FQVFVSRV9QQVRIO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcHJvY2Vzcy5lbnYuR1NEX1RFU1RfVEFTS19DT01QTEVURV9DQVBUVVJFX1BBVEggPSBwcmV2Q2FwdHVyZTtcbiAgICAgIH1cbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICBpdChcImdzZF9jb21wbGV0ZV90YXNrIGFsaWFzIGRlbGVnYXRlcyB0byBnc2RfdGFza19jb21wbGV0ZSBiZWhhdmlvclwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAyXCIsIFwic2xpY2VzXCIsIFwiUzAyXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDJcIiwgXCJzbGljZXNcIiwgXCJTMDJcIiwgXCJTMDItUExBTi5tZFwiKSxcbiAgICAgICAgXCIjIFMwMlxcblxcbi0gWyBdICoqVDAyOiBEZW1vKiogYGVzdDo1bWBcXG5cIixcbiAgICAgICk7XG5cbiAgICAgIGNvbnN0IHNlcnZlciA9IG1ha2VNb2NrU2VydmVyKCk7XG4gICAgICByZWdpc3RlcldvcmtmbG93VG9vbHMoc2VydmVyIGFzIGFueSk7XG4gICAgICBjb25zdCBhbGlhc1Rvb2wgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF9jb21wbGV0ZV90YXNrXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGFsaWFzVG9vbCwgXCJ0YXNrIGNvbXBsZXRpb24gYWxpYXMgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGFsaWFzVG9vbCEuaGFuZGxlcih7XG4gICAgICAgIHByb2plY3REaXI6IGJhc2UsXG4gICAgICAgIHRhc2tJZDogXCJUMDJcIixcbiAgICAgICAgc2xpY2VJZDogXCJTMDJcIixcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMlwiLFxuICAgICAgICBvbmVMaW5lcjogXCJDb21wbGV0ZWQgdGFzayB2aWEgYWxpYXNcIixcbiAgICAgICAgbmFycmF0aXZlOiBcIkRpZCB0aGUgd29yayB0aHJvdWdoIGFsaWFzXCIsXG4gICAgICAgIHZlcmlmaWNhdGlvbjogXCJucG0gdGVzdFwiLFxuICAgICAgfSk7XG5cbiAgICAgIGFzc2VydC5tYXRjaCgocmVzdWx0IGFzIGFueSkuY29udGVudFswXS50ZXh0IGFzIHN0cmluZywgL0NvbXBsZXRlZCB0YXNrIFQwMi8pO1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBleGlzdHNTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDJcIiwgXCJzbGljZXNcIiwgXCJTMDJcIiwgXCJ0YXNrc1wiLCBcIlQwMi1TVU1NQVJZLm1kXCIpKSxcbiAgICAgICAgXCJhbGlhcyBzaG91bGQgd3JpdGUgdGFzayBzdW1tYXJ5IHRvIGRpc2tcIixcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICBpdChcImdzZF9wbGFuX21pbGVzdG9uZSBhbmQgZ3NkX3BsYW5fc2xpY2Ugd29yayBlbmQtdG8tZW5kXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc2VydmVyID0gbWFrZU1vY2tTZXJ2ZXIoKTtcbiAgICAgIHJlZ2lzdGVyV29ya2Zsb3dUb29scyhzZXJ2ZXIgYXMgYW55KTtcbiAgICAgIGNvbnN0IG1pbGVzdG9uZVRvb2wgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF9wbGFuX21pbGVzdG9uZVwiKTtcbiAgICAgIGNvbnN0IHNsaWNlVG9vbCA9IHNlcnZlci50b29scy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09IFwiZ3NkX3BsYW5fc2xpY2VcIik7XG4gICAgICBhc3NlcnQub2sobWlsZXN0b25lVG9vbCwgXCJtaWxlc3RvbmUgcGxhbm5pbmcgdG9vbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcbiAgICAgIGFzc2VydC5vayhzbGljZVRvb2wsIFwic2xpY2UgcGxhbm5pbmcgdG9vbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcblxuICAgICAgY29uc3QgbWlsZXN0b25lUmVzdWx0ID0gYXdhaXQgbWlsZXN0b25lVG9vbCEuaGFuZGxlcih7XG4gICAgICAgIHByb2plY3REaXI6IGJhc2UsXG4gICAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgICAgdGl0bGU6IFwiV29ya2Zsb3cgTUNQIHBsYW5uaW5nXCIsXG4gICAgICAgIHZpc2lvbjogXCJQbGFuIG1pbGVzdG9uZSBvdmVyIE1DUC5cIixcbiAgICAgICAgc2xpY2VzOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgc2xpY2VJZDogXCJTMDFcIixcbiAgICAgICAgICAgIHRpdGxlOiBcIkJyaWRnZSBwbGFubmluZ1wiLFxuICAgICAgICAgICAgcmlzazogXCJtZWRpdW1cIixcbiAgICAgICAgICAgIGRlcGVuZHM6IFtdLFxuICAgICAgICAgICAgZGVtbzogXCJNaWxlc3RvbmUgcGxhbiBwZXJzaXN0cyB0aHJvdWdoIE1DUC5cIixcbiAgICAgICAgICAgIGdvYWw6IFwiUGVyc2lzdCByb2FkbWFwIHN0YXRlLlwiLFxuICAgICAgICAgICAgc3VjY2Vzc0NyaXRlcmlhOiBcIlJPQURNQVAubWQgcmVuZGVycyBmcm9tIERCLlwiLFxuICAgICAgICAgICAgcHJvb2ZMZXZlbDogXCJpbnRlZ3JhdGlvblwiLFxuICAgICAgICAgICAgaW50ZWdyYXRpb25DbG9zdXJlOiBcIlByb21wdHMgYW5kIE1DUCBjYWxsIHRoZSBzYW1lIGhhbmRsZXIuXCIsXG4gICAgICAgICAgICBvYnNlcnZhYmlsaXR5SW1wYWN0OiBcIkV4ZWN1dG9yIHRlc3RzIGNvdmVyIG91dHB1dCBwYXRocy5cIixcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgICBhc3NlcnQubWF0Y2goKG1pbGVzdG9uZVJlc3VsdCBhcyBhbnkpLmNvbnRlbnRbMF0udGV4dCBhcyBzdHJpbmcsIC9QbGFubmVkIG1pbGVzdG9uZSBNMDAxLyk7XG5cbiAgICAgIGNvbnN0IHNsaWNlUmVzdWx0ID0gYXdhaXQgc2xpY2VUb29sIS5oYW5kbGVyKHtcbiAgICAgICAgcHJvamVjdERpcjogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICBzbGljZUlkOiBcIlMwMVwiLFxuICAgICAgICBnb2FsOiBcIlBlcnNpc3Qgc2xpY2UgcGxhbiBvdmVyIE1DUC5cIixcbiAgICAgICAgdGFza3M6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICB0YXNrSWQ6IFwiVDAxXCIsXG4gICAgICAgICAgICB0aXRsZTogXCJBZGQgcGxhbm5pbmcgYnJpZGdlXCIsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogXCJJbXBsZW1lbnQgdGhlIHNoYXJlZCBleGVjdXRvciBwYXRoLlwiLFxuICAgICAgICAgICAgZXN0aW1hdGU6IFwiMTVtXCIsXG4gICAgICAgICAgICBmaWxlczogW1wic3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90b29scy93b3JrZmxvdy10b29sLWV4ZWN1dG9ycy50c1wiXSxcbiAgICAgICAgICAgIHZlcmlmeTogXCJub2RlIC0tdGVzdFwiLFxuICAgICAgICAgICAgaW5wdXRzOiBbXCIuZ3NkL21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWRcIl0sXG4gICAgICAgICAgICBleHBlY3RlZE91dHB1dDogW1wiUzAxLVBMQU4ubWRcIiwgXCJUMDEtUExBTi5tZFwiXSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgICBhc3NlcnQubWF0Y2goKHNsaWNlUmVzdWx0IGFzIGFueSkuY29udGVudFswXS50ZXh0IGFzIHN0cmluZywgL1BsYW5uZWQgc2xpY2UgUzAxLyk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIGV4aXN0c1N5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiLCBcIlMwMS1QTEFOLm1kXCIpKSxcbiAgICAgICAgXCJzbGljZSBwbGFuIHNob3VsZCBleGlzdCBvbiBkaXNrXCIsXG4gICAgICApO1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBleGlzdHNTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJ0YXNrc1wiLCBcIlQwMS1QTEFOLm1kXCIpKSxcbiAgICAgICAgXCJ0YXNrIHBsYW4gc2hvdWxkIGV4aXN0IG9uIGRpc2tcIixcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICBpdChcIm90aGVyIHdvcmtmbG93IHRvb2xzIHJlamVjdCBlbXB0eSByZXF1aXJlZCBzdHJpbmdzIGF0IHRoZSBzY2hlbWEgbGF5ZXJcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzZXJ2ZXIgPSBtYWtlTW9ja1NlcnZlcigpO1xuICAgICAgcmVnaXN0ZXJXb3JrZmxvd1Rvb2xzKHNlcnZlciBhcyBhbnkpO1xuXG4gICAgICBjb25zdCBleHBlY3RSZWplY3Rpb24gPSBhc3luYyAodG9vbE5hbWU6IHN0cmluZywgYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIGV4cGVjdGVkRmllbGQ6IHN0cmluZykgPT4ge1xuICAgICAgICBjb25zdCB0b29sID0gc2VydmVyLnRvb2xzLmZpbmQoKHQpID0+IHQubmFtZSA9PT0gdG9vbE5hbWUpO1xuICAgICAgICBhc3NlcnQub2sodG9vbCwgYCR7dG9vbE5hbWV9IHNob3VsZCBiZSByZWdpc3RlcmVkYCk7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRvb2whLmhhbmRsZXIoYXJncyk7XG4gICAgICAgIGFzc2VydFRvb2xFcnJvcihyZXN1bHQsIGV4cGVjdGVkRmllbGQpO1xuICAgICAgfTtcblxuICAgICAgLy8gRW1wdHkgc2xpY2VJZCB0b3AtbGV2ZWxcbiAgICAgIGF3YWl0IGV4cGVjdFJlamVjdGlvbihcImdzZF9wbGFuX3NsaWNlXCIsIHtcbiAgICAgICAgcHJvamVjdERpcjogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICBzbGljZUlkOiBcIlwiLFxuICAgICAgICBnb2FsOiBcIlBlcnNpc3Qgc2xpY2UgcGxhbi5cIixcbiAgICAgICAgdGFza3M6IFtdLFxuICAgICAgfSwgXCJzbGljZUlkXCIpO1xuXG4gICAgICAvLyBFbXB0eSB0YXNrIHZlcmlmeSBpbnNpZGUgdGFza3MgYXJyYXlcbiAgICAgIGF3YWl0IGV4cGVjdFJlamVjdGlvbihcImdzZF9wbGFuX3NsaWNlXCIsIHtcbiAgICAgICAgcHJvamVjdERpcjogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICBzbGljZUlkOiBcIlMwMVwiLFxuICAgICAgICBnb2FsOiBcIlBlcnNpc3Qgc2xpY2UgcGxhbi5cIixcbiAgICAgICAgdGFza3M6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICB0YXNrSWQ6IFwiVDAxXCIsXG4gICAgICAgICAgICB0aXRsZTogXCJBZGQgYnJpZGdlXCIsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogXCJJbXBsZW1lbnQgYnJpZGdlLlwiLFxuICAgICAgICAgICAgZXN0aW1hdGU6IFwiMTVtXCIsXG4gICAgICAgICAgICBmaWxlczogW1wic3JjL3gudHNcIl0sXG4gICAgICAgICAgICB2ZXJpZnk6IFwiXCIsXG4gICAgICAgICAgICBpbnB1dHM6IFtcIlJPQURNQVAubWRcIl0sXG4gICAgICAgICAgICBleHBlY3RlZE91dHB1dDogW1wiUzAxLVBMQU4ubWRcIl0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sIFwidmVyaWZ5XCIpO1xuXG4gICAgICAvLyBFbXB0eSBlbGVtZW50IGluc2lkZSBmaWxlc1tdIGFycmF5XG4gICAgICBhd2FpdCBleHBlY3RSZWplY3Rpb24oXCJnc2RfcGxhbl9zbGljZVwiLCB7XG4gICAgICAgIHByb2plY3REaXI6IGJhc2UsXG4gICAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgICAgc2xpY2VJZDogXCJTMDFcIixcbiAgICAgICAgZ29hbDogXCJQZXJzaXN0IHNsaWNlIHBsYW4uXCIsXG4gICAgICAgIHRhc2tzOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgdGFza0lkOiBcIlQwMVwiLFxuICAgICAgICAgICAgdGl0bGU6IFwiQWRkIGJyaWRnZVwiLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246IFwiSW1wbGVtZW50IGJyaWRnZS5cIixcbiAgICAgICAgICAgIGVzdGltYXRlOiBcIjE1bVwiLFxuICAgICAgICAgICAgZmlsZXM6IFtcInNyYy94LnRzXCIsIFwiICAgXCJdLFxuICAgICAgICAgICAgdmVyaWZ5OiBcIm5vZGUgLS10ZXN0XCIsXG4gICAgICAgICAgICBpbnB1dHM6IFtcIlJPQURNQVAubWRcIl0sXG4gICAgICAgICAgICBleHBlY3RlZE91dHB1dDogW1wiUzAxLVBMQU4ubWRcIl0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sIFwiZmlsZXNcIik7XG5cbiAgICAgIC8vIEVtcHR5IG1pbGVzdG9uZUlkIG9uIGdzZF9wbGFuX3Rhc2tcbiAgICAgIGF3YWl0IGV4cGVjdFJlamVjdGlvbihcImdzZF9wbGFuX3Rhc2tcIiwge1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJcIixcbiAgICAgICAgc2xpY2VJZDogXCJTMDFcIixcbiAgICAgICAgdGFza0lkOiBcIlQwMVwiLFxuICAgICAgICB0aXRsZTogXCJ0XCIsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBcImRcIixcbiAgICAgICAgZXN0aW1hdGU6IFwiMW1cIixcbiAgICAgICAgZmlsZXM6IFtdLFxuICAgICAgICB2ZXJpZnk6IFwidlwiLFxuICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICBleHBlY3RlZE91dHB1dDogW10sXG4gICAgICB9LCBcIm1pbGVzdG9uZUlkXCIpO1xuXG4gICAgICAvLyBFbXB0eSBvYnNlcnZhYmlsaXR5SW1wYWN0IGV4cGxpY2l0bHkgcmVqZWN0ZWQgKG9wdGlvbmFsLWJ1dC1ub24tZW1wdHkpXG4gICAgICBhd2FpdCBleHBlY3RSZWplY3Rpb24oXCJnc2RfcGxhbl90YXNrXCIsIHtcbiAgICAgICAgcHJvamVjdERpcjogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICBzbGljZUlkOiBcIlMwMVwiLFxuICAgICAgICB0YXNrSWQ6IFwiVDAxXCIsXG4gICAgICAgIHRpdGxlOiBcInRcIixcbiAgICAgICAgZGVzY3JpcHRpb246IFwiZFwiLFxuICAgICAgICBlc3RpbWF0ZTogXCIxbVwiLFxuICAgICAgICBmaWxlczogW10sXG4gICAgICAgIHZlcmlmeTogXCJ2XCIsXG4gICAgICAgIGlucHV0czogW10sXG4gICAgICAgIGV4cGVjdGVkT3V0cHV0OiBbXSxcbiAgICAgICAgb2JzZXJ2YWJpbGl0eUltcGFjdDogXCIgICBcIixcbiAgICAgIH0sIFwib2JzZXJ2YWJpbGl0eUltcGFjdFwiKTtcblxuICAgICAgLy8gRW1wdHkgYXNzZXNzbWVudCBvbiBnc2RfcmVhc3Nlc3Nfcm9hZG1hcFxuICAgICAgYXdhaXQgZXhwZWN0UmVqZWN0aW9uKFwiZ3NkX3JlYXNzZXNzX3JvYWRtYXBcIiwge1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIGNvbXBsZXRlZFNsaWNlSWQ6IFwiUzAxXCIsXG4gICAgICAgIHZlcmRpY3Q6IFwicm9hZG1hcC1jb25maXJtZWRcIixcbiAgICAgICAgYXNzZXNzbWVudDogXCJcIixcbiAgICAgICAgc2xpY2VDaGFuZ2VzOiB7IG1vZGlmaWVkOiBbXSwgYWRkZWQ6IFtdLCByZW1vdmVkOiBbXSB9LFxuICAgICAgfSwgXCJhc3Nlc3NtZW50XCIpO1xuXG4gICAgICAvLyBFbXB0eSBrZXlSaXNrc1tpXS5yaXNrIG9uIGdzZF9wbGFuX21pbGVzdG9uZSB0b3AtbGV2ZWwgYXJyYXlzXG4gICAgICBhd2FpdCBleHBlY3RSZWplY3Rpb24oXCJnc2RfcGxhbl9taWxlc3RvbmVcIiwge1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIHRpdGxlOiBcIlRcIixcbiAgICAgICAgdmlzaW9uOiBcIlZcIixcbiAgICAgICAgc2xpY2VzOiBbXSxcbiAgICAgICAga2V5Umlza3M6IFt7IHJpc2s6IFwiXCIsIHdoeUl0TWF0dGVyczogXCJiZWNhdXNlLlwiIH1dLFxuICAgICAgfSwgXCJyaXNrXCIpO1xuXG4gICAgICAvLyBFbXB0eSBibG9ja2VyRGVzY3JpcHRpb24gb24gZ3NkX3JlcGxhbl9zbGljZVxuICAgICAgYXdhaXQgZXhwZWN0UmVqZWN0aW9uKFwiZ3NkX3JlcGxhbl9zbGljZVwiLCB7XG4gICAgICAgIHByb2plY3REaXI6IGJhc2UsXG4gICAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgICAgc2xpY2VJZDogXCJTMDFcIixcbiAgICAgICAgYmxvY2tlclRhc2tJZDogXCJUMDFcIixcbiAgICAgICAgYmxvY2tlckRlc2NyaXB0aW9uOiBcIlwiLFxuICAgICAgICB3aGF0Q2hhbmdlZDogXCJ4XCIsXG4gICAgICAgIHVwZGF0ZWRUYXNrczogW10sXG4gICAgICAgIHJlbW92ZWRUYXNrSWRzOiBbXSxcbiAgICAgIH0sIFwiYmxvY2tlckRlc2NyaXB0aW9uXCIpO1xuXG4gICAgICAvLyBFbXB0eSBtaWxlc3RvbmVJZCBvbiBnc2RfdGFza19jb21wbGV0ZVxuICAgICAgYXdhaXQgZXhwZWN0UmVqZWN0aW9uKFwiZ3NkX3Rhc2tfY29tcGxldGVcIiwge1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICB0YXNrSWQ6IFwiVDAxXCIsXG4gICAgICAgIHNsaWNlSWQ6IFwiUzAxXCIsXG4gICAgICAgIG1pbGVzdG9uZUlkOiBcIlwiLFxuICAgICAgICBvbmVMaW5lcjogXCJvbFwiLFxuICAgICAgICBuYXJyYXRpdmU6IFwiblwiLFxuICAgICAgICB2ZXJpZmljYXRpb246IFwidlwiLFxuICAgICAgfSwgXCJtaWxlc3RvbmVJZFwiKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwiZ3NkX3BsYW5fbWlsZXN0b25lIHJlamVjdHMgZW1wdHkgc2xpY2UgZmllbGRzIHVwIGZyb250IHdpdGggYWxsIHZpb2xhdGlvbnNcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzZXJ2ZXIgPSBtYWtlTW9ja1NlcnZlcigpO1xuICAgICAgcmVnaXN0ZXJXb3JrZmxvd1Rvb2xzKHNlcnZlciBhcyBhbnkpO1xuICAgICAgY29uc3QgbWlsZXN0b25lVG9vbCA9IHNlcnZlci50b29scy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09IFwiZ3NkX3BsYW5fbWlsZXN0b25lXCIpO1xuICAgICAgYXNzZXJ0Lm9rKG1pbGVzdG9uZVRvb2wsIFwibWlsZXN0b25lIHBsYW5uaW5nIHRvb2wgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG1pbGVzdG9uZVRvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIHRpdGxlOiBcIldvcmtmbG93IE1DUCBwbGFubmluZ1wiLFxuICAgICAgICB2aXNpb246IFwiUGxhbiBtaWxlc3RvbmUgb3ZlciBNQ1AuXCIsXG4gICAgICAgIHNsaWNlczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIHNsaWNlSWQ6IFwiUzAxXCIsXG4gICAgICAgICAgICB0aXRsZTogXCJCcmlkZ2UgcGxhbm5pbmdcIixcbiAgICAgICAgICAgIHJpc2s6IFwibWVkaXVtXCIsXG4gICAgICAgICAgICBkZXBlbmRzOiBbXSxcbiAgICAgICAgICAgIGRlbW86IFwiTWlsZXN0b25lIHBsYW4gcGVyc2lzdHMgdGhyb3VnaCBNQ1AuXCIsXG4gICAgICAgICAgICBnb2FsOiBcIlBlcnNpc3Qgcm9hZG1hcCBzdGF0ZS5cIixcbiAgICAgICAgICAgIHN1Y2Nlc3NDcml0ZXJpYTogXCJcIixcbiAgICAgICAgICAgIHByb29mTGV2ZWw6IFwiXCIsXG4gICAgICAgICAgICBpbnRlZ3JhdGlvbkNsb3N1cmU6IFwiICAgXCIsXG4gICAgICAgICAgICBvYnNlcnZhYmlsaXR5SW1wYWN0OiBcIlwiLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IG1lc3NhZ2UgPSBhc3NlcnRUb29sRXJyb3IocmVzdWx0LCBcInN1Y2Nlc3NDcml0ZXJpYVwiKTtcbiAgICAgIGZvciAoY29uc3QgZmllbGQgb2YgW1wic3VjY2Vzc0NyaXRlcmlhXCIsIFwicHJvb2ZMZXZlbFwiLCBcImludGVncmF0aW9uQ2xvc3VyZVwiLCBcIm9ic2VydmFiaWxpdHlJbXBhY3RcIl0pIHtcbiAgICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICAgIG1lc3NhZ2UuaW5jbHVkZXMoZmllbGQpLFxuICAgICAgICAgIGBwYXJzZSBlcnJvciBzaG91bGQgbWVudGlvbiAke2ZpZWxkfSwgZ290OiAke21lc3NhZ2V9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwiZ3NkX3BsYW5fbWlsZXN0b25lIHJlamVjdHMgYSBmdWxsIHNsaWNlIHdpdGggbWlzc2luZyBoZWF2eSBmaWVsZHMgdmlhIGEgYmVoYXZpb3JhbCByb3VuZC10cmlwXCIsIGFzeW5jICgpID0+IHtcbiAgICAvLyBCZWhhdmlvcmFsIGd1YXJkIGZvciB0aGUgZnVsbC12cy1za2V0Y2ggY29uZGl0aW9uYWwuIFRoZSBvcmlnaW5hbFxuICAgIC8vIHJlZ3Jlc3Npb24gKGludmlzaWJsZSBcInJlcXVpcmVkIHVubGVzcyBpc1NrZXRjaFwiIHJlcXVpcmVtZW50KSBpc1xuICAgIC8vIHN1cmZhY2VkIHRvIHVzZXJzIHRocm91Z2ggdHdvIGRpc3RpbmN0IHJ1bnRpbWUgY2hhbm5lbHM6XG4gICAgLy8gICAxLiBBIHBhcnNlLXRpbWUgcmVqZWN0aW9uIHdoZW4gdGhlIHRvb2wgaXMgY2FsbGVkIHdpdGggZW1wdHkgaGVhdnlcbiAgICAvLyAgICAgIGZpZWxkcyBvbiBhIG5vbi1za2V0Y2ggc2xpY2UgKG5vIGlzU2tldGNoPXRydWUpLlxuICAgIC8vICAgMi4gQW4gYWNjZXB0YW5jZSB3aGVuIGlzU2tldGNoPXRydWUgKyBza2V0Y2hTY29wZSBpcyBzdXBwbGllZCBhbmRcbiAgICAvLyAgICAgIGhlYXZ5IGZpZWxkcyBhcmUgb21pdHRlZC5cbiAgICAvLyBCb3RoIGFybXMgYXJlIGV4ZXJjaXNlZCBiZWxvdyBhZ2FpbnN0IHRoZSBsaXZlIGhhbmRsZXIgXHUyMDE0IGFueSBzY2hlbWFcbiAgICAvLyByZWZhY3RvciB0aGF0IHByZXNlcnZlcyB0aGUgdXNlci1vYnNlcnZhYmxlIGNvbnRyYWN0IChyZWplY3Rpb24gK1xuICAgIC8vIGFjY2VwdGFuY2UpIHBhc3NlcywgYW5kIGFueSByZWZhY3RvciB0aGF0IGJyZWFrcyB0aGUgY29udHJhY3RcbiAgICAvLyBmYWlscywgcmVnYXJkbGVzcyBvZiB3aGV0aGVyIGludGVybmFsIGAuZGVzY3JpYmUoKWAgcHJvc2UgY2hhbmdlcy5cbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc2VydmVyID0gbWFrZU1vY2tTZXJ2ZXIoKTtcbiAgICAgIHJlZ2lzdGVyV29ya2Zsb3dUb29scyhzZXJ2ZXIgYXMgYW55KTtcbiAgICAgIGNvbnN0IG1pbGVzdG9uZVRvb2wgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF9wbGFuX21pbGVzdG9uZVwiKTtcbiAgICAgIGFzc2VydC5vayhtaWxlc3RvbmVUb29sLCBcIm1pbGVzdG9uZSBwbGFubmluZyB0b29sIHNob3VsZCBiZSByZWdpc3RlcmVkXCIpO1xuXG4gICAgICAvLyBBcm0gMTogZnVsbCBzbGljZSAoaXNTa2V0Y2ggb21pdHRlZCkgd2l0aCB0aGUgaGVhdnkgZmllbGRzIG1pc3NpbmdcbiAgICAgIC8vIG11c3QgcmVqZWN0IGFuZCBuYW1lIEFMTCBmb3VyIGZpZWxkcyBzbyB0aGUgYWdlbnQgY2FuIHNlbGYtY29ycmVjdC5cbiAgICAgIGNvbnN0IGZ1bGxSZXN1bHQgPSBhd2FpdCBtaWxlc3RvbmVUb29sIS5oYW5kbGVyKHtcbiAgICAgICAgcHJvamVjdERpcjogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICB0aXRsZTogXCJGdWxsIHNsaWNlIHBhdGhcIixcbiAgICAgICAgdmlzaW9uOiBcIkJlaGF2aW9yYWwgdGVzdCBmb3IgaXNTa2V0Y2ggY29uZGl0aW9uYWwuXCIsXG4gICAgICAgIHNsaWNlczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIHNsaWNlSWQ6IFwiUzAxXCIsXG4gICAgICAgICAgICB0aXRsZTogXCJIZWF2eSBzbGljZVwiLFxuICAgICAgICAgICAgcmlzazogXCJtZWRpdW1cIixcbiAgICAgICAgICAgIGRlcGVuZHM6IFtdLFxuICAgICAgICAgICAgZGVtbzogXCJEZW1vLlwiLFxuICAgICAgICAgICAgZ29hbDogXCJHb2FsLlwiLFxuICAgICAgICAgICAgLy8gaGVhdnkgZmllbGRzIGludGVudGlvbmFsbHkgb21pdHRlZFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IGZ1bGxNc2cgPSBhc3NlcnRUb29sRXJyb3IoZnVsbFJlc3VsdCwgXCJzdWNjZXNzQ3JpdGVyaWFcIik7XG4gICAgICBmb3IgKGNvbnN0IGZpZWxkIG9mIFtcInN1Y2Nlc3NDcml0ZXJpYVwiLCBcInByb29mTGV2ZWxcIiwgXCJpbnRlZ3JhdGlvbkNsb3N1cmVcIiwgXCJvYnNlcnZhYmlsaXR5SW1wYWN0XCJdKSB7XG4gICAgICAgIGFzc2VydC5vayhcbiAgICAgICAgICBmdWxsTXNnLmluY2x1ZGVzKGZpZWxkKSxcbiAgICAgICAgICBgcmVqZWN0aW9uIG11c3QgbmFtZSAke2ZpZWxkfSBzbyBhZ2VudHMgY2FuIHJlY292ZXIgd2l0aG91dCBhIHNlY29uZCByb3VuZC10cmlwOyBnb3Q6ICR7ZnVsbE1zZ31gLFxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICAvLyBBcm0gMjogc2tldGNoIHNsaWNlIChpc1NrZXRjaD10cnVlICsgc2tldGNoU2NvcGUpIHdpdGggaGVhdnkgZmllbGRzXG4gICAgICAvLyBvbWl0dGVkIG11c3QgYmUgYWNjZXB0ZWQgXHUyMDE0IHByb3ZpbmcgdGhlIGNvbmRpdGlvbmFsIGlzIGxpdmUuIEFzc2VydFxuICAgICAgLy8gc3VjY2VzcyBkaXJlY3RseSByYXRoZXIgdGhhbiBqdXN0IGNoZWNraW5nIGEgdGhyb3duIG1lc3NhZ2Ugb21pdHNcbiAgICAgIC8vIHRoZSBoZWF2eS1maWVsZCBuYW1lczogYSBnZW5lcmljIGZhaWx1cmUgd291bGQgb3RoZXJ3aXNlIHNpbGVudGx5XG4gICAgICAvLyBwYXNzIHRoaXMgYXJtLlxuICAgICAgY29uc3Qgc2tldGNoUmVzdWx0ID0gYXdhaXQgbWlsZXN0b25lVG9vbCEuaGFuZGxlcih7XG4gICAgICAgIHByb2plY3REaXI6IGJhc2UsXG4gICAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDJcIixcbiAgICAgICAgdGl0bGU6IFwiU2tldGNoIHNsaWNlIHBhdGhcIixcbiAgICAgICAgdmlzaW9uOiBcIkJlaGF2aW9yYWwgdGVzdCBmb3IgaXNTa2V0Y2ggY29uZGl0aW9uYWwuXCIsXG4gICAgICAgIHNsaWNlczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIHNsaWNlSWQ6IFwiUzAxXCIsXG4gICAgICAgICAgICB0aXRsZTogXCJTa2V0Y2ggc2xpY2VcIixcbiAgICAgICAgICAgIHJpc2s6IFwibWVkaXVtXCIsXG4gICAgICAgICAgICBkZXBlbmRzOiBbXSxcbiAgICAgICAgICAgIGRlbW86IFwiRGVtby5cIixcbiAgICAgICAgICAgIGdvYWw6IFwiR29hbC5cIixcbiAgICAgICAgICAgIGlzU2tldGNoOiB0cnVlLFxuICAgICAgICAgICAgc2tldGNoU2NvcGU6IFwiVHdvLXNlbnRlbmNlIHNjb3BlLiBCb3VuZGFyeSBkZWZpbmVkLlwiLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICAgIGFzc2VydC5tYXRjaChcbiAgICAgICAgKHNrZXRjaFJlc3VsdCBhcyBhbnkpLmNvbnRlbnRbMF0udGV4dCBhcyBzdHJpbmcsXG4gICAgICAgIC9QbGFubmVkIG1pbGVzdG9uZSBNMDAyLyxcbiAgICAgICAgXCJza2V0Y2ggc2xpY2Ugd2l0aCBpc1NrZXRjaD10cnVlIG11c3QgYmUgYWNjZXB0ZWQgYnkgdGhlIGhhbmRsZXJcIixcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICBpdChcImdzZF9wbGFuX21pbGVzdG9uZSByZXF1aXJlcyBza2V0Y2hTY29wZSB3aGVuIGlzU2tldGNoPXRydWUgYW5kIHNraXBzIGhlYXZ5IGZpZWxkc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHNlcnZlciA9IG1ha2VNb2NrU2VydmVyKCk7XG4gICAgICByZWdpc3RlcldvcmtmbG93VG9vbHMoc2VydmVyIGFzIGFueSk7XG4gICAgICBjb25zdCBtaWxlc3RvbmVUb29sID0gc2VydmVyLnRvb2xzLmZpbmQoKHQpID0+IHQubmFtZSA9PT0gXCJnc2RfcGxhbl9taWxlc3RvbmVcIik7XG4gICAgICBhc3NlcnQub2sobWlsZXN0b25lVG9vbCwgXCJtaWxlc3RvbmUgcGxhbm5pbmcgdG9vbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcblxuICAgICAgY29uc3QgZW1wdHlTa2V0Y2hSZXN1bHQgPSBhd2FpdCBtaWxlc3RvbmVUb29sIS5oYW5kbGVyKHtcbiAgICAgICAgcHJvamVjdERpcjogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICB0aXRsZTogXCJTa2V0Y2ggbWlsZXN0b25lXCIsXG4gICAgICAgIHZpc2lvbjogXCJTa2V0Y2ggZmlyc3QsIHJlZmluZSBsYXRlci5cIixcbiAgICAgICAgc2xpY2VzOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgc2xpY2VJZDogXCJTMDFcIixcbiAgICAgICAgICAgIHRpdGxlOiBcIlNrZXRjaCBzbGljZVwiLFxuICAgICAgICAgICAgcmlzazogXCJsb3dcIixcbiAgICAgICAgICAgIGRlcGVuZHM6IFtdLFxuICAgICAgICAgICAgZGVtbzogXCJTdHViIGRlbW8uXCIsXG4gICAgICAgICAgICBnb2FsOiBcIlN0dWIgZ29hbC5cIixcbiAgICAgICAgICAgIGlzU2tldGNoOiB0cnVlLFxuICAgICAgICAgICAgc2tldGNoU2NvcGU6IFwiXCIsXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuICAgICAgYXNzZXJ0VG9vbEVycm9yKGVtcHR5U2tldGNoUmVzdWx0LCBcInNrZXRjaFNjb3BlXCIpO1xuXG4gICAgICBjb25zdCBza2V0Y2hSZXN1bHQgPSBhd2FpdCBtaWxlc3RvbmVUb29sIS5oYW5kbGVyKHtcbiAgICAgICAgcHJvamVjdERpcjogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICB0aXRsZTogXCJTa2V0Y2ggbWlsZXN0b25lXCIsXG4gICAgICAgIHZpc2lvbjogXCJTa2V0Y2ggZmlyc3QsIHJlZmluZSBsYXRlci5cIixcbiAgICAgICAgc2xpY2VzOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgc2xpY2VJZDogXCJTMDFcIixcbiAgICAgICAgICAgIHRpdGxlOiBcIlNrZXRjaCBzbGljZVwiLFxuICAgICAgICAgICAgcmlzazogXCJsb3dcIixcbiAgICAgICAgICAgIGRlcGVuZHM6IFtdLFxuICAgICAgICAgICAgZGVtbzogXCJTdHViIGRlbW8uXCIsXG4gICAgICAgICAgICBnb2FsOiBcIlN0dWIgZ29hbC5cIixcbiAgICAgICAgICAgIGlzU2tldGNoOiB0cnVlLFxuICAgICAgICAgICAgc2tldGNoU2NvcGU6IFwiRGVmZXIgaGVhdnkgcGxhbm5pbmcgZmllbGRzIHVudGlsIHJlZmluZS1zbGljZS5cIixcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgICBhc3NlcnQubWF0Y2goKHNrZXRjaFJlc3VsdCBhcyBhbnkpLmNvbnRlbnRbMF0udGV4dCBhcyBzdHJpbmcsIC9QbGFubmVkIG1pbGVzdG9uZSBNMDAxLyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICBpdChcImdzZF9yZXF1aXJlbWVudF9zYXZlIG9wZW5zIHRoZSBEQiBiZWZvcmUgaW5saW5lIHJlcXVpcmVtZW50IHdyaXRlc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHNlcnZlciA9IG1ha2VNb2NrU2VydmVyKCk7XG4gICAgICByZWdpc3RlcldvcmtmbG93VG9vbHMoc2VydmVyIGFzIGFueSk7XG4gICAgICBjb25zdCByZXF1aXJlbWVudFRvb2wgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF9yZXF1aXJlbWVudF9zYXZlXCIpO1xuICAgICAgYXNzZXJ0Lm9rKHJlcXVpcmVtZW50VG9vbCwgXCJyZXF1aXJlbWVudCB0b29sIHNob3VsZCBiZSByZWdpc3RlcmVkXCIpO1xuXG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVpcmVtZW50VG9vbCEuaGFuZGxlcih7XG4gICAgICAgIHByb2plY3REaXI6IGJhc2UsXG4gICAgICAgIGNsYXNzOiBcIm9wZXJhYmlsaXR5XCIsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBcIklubGluZSBNQ1AgcmVxdWlyZW1lbnQgc2F2ZSByZWdyZXNzaW9uXCIsXG4gICAgICAgIHdoeTogXCJSZXByb2R1Y2UgbWlzc2luZyBlbnN1cmVEYk9wZW4gaW4gd29ya2Zsb3ctdG9vbHNcIixcbiAgICAgICAgc291cmNlOiBcInVzZXJcIixcbiAgICAgICAgc3RhdHVzOiBcImFjdGl2ZVwiLFxuICAgICAgICBwcmltYXJ5X293bmVyOiBcIk0wMTAvUzEwXCIsXG4gICAgICAgIHZhbGlkYXRpb246IFwibi9hXCIsXG4gICAgICB9KTtcblxuICAgICAgYXNzZXJ0Lm1hdGNoKChyZXN1bHQgYXMgYW55KS5jb250ZW50WzBdLnRleHQgYXMgc3RyaW5nLCAvU2F2ZWQgcmVxdWlyZW1lbnQgUlxcZCsvKTtcbiAgICAgIGFzc2VydC5vayhleGlzdHNTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUkVRVUlSRU1FTlRTLm1kXCIpKSwgXCJSRVFVSVJFTUVOVFMubWQgc2hvdWxkIGJlIHdyaXR0ZW4gdG8gZGlza1wiKTtcbiAgICAgIGNvbnN0IHJvdyA9IF9nZXRBZGFwdGVyKCkhXG4gICAgICAgIC5wcmVwYXJlKFwiU0VMRUNUIGlkLCBjbGFzcywgZGVzY3JpcHRpb24gRlJPTSByZXF1aXJlbWVudHMgV0hFUkUgZGVzY3JpcHRpb24gPSA/XCIpXG4gICAgICAgIC5nZXQoXCJJbmxpbmUgTUNQIHJlcXVpcmVtZW50IHNhdmUgcmVncmVzc2lvblwiKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgICAgIGFzc2VydC5vayhyb3csIFwicmVxdWlyZW1lbnQgc2hvdWxkIGJlIHdyaXR0ZW4gdG8gdGhlIGRhdGFiYXNlXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJvd1tcImNsYXNzXCJdLCBcIm9wZXJhYmlsaXR5XCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoXCJnc2RfbWlsZXN0b25lX2dlbmVyYXRlX2lkIHNraXBzIERCLW9ubHkgcXVldWVkIG1pbGVzdG9uZSByb3dzXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc2VydmVyID0gbWFrZU1vY2tTZXJ2ZXIoKTtcbiAgICAgIHJlZ2lzdGVyV29ya2Zsb3dUb29scyhzZXJ2ZXIgYXMgYW55KTtcbiAgICAgIGNvbnN0IHRvb2wgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF9taWxlc3RvbmVfZ2VuZXJhdGVfaWRcIik7XG4gICAgICBhc3NlcnQub2sodG9vbCwgXCJtaWxlc3RvbmUgSUQgdG9vbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcblxuICAgICAgY29uc3QgZmlyc3QgPSBhd2FpdCB0b29sIS5oYW5kbGVyKHsgcHJvamVjdERpcjogYmFzZSB9KTtcbiAgICAgIGFzc2VydC5lcXVhbCgoZmlyc3QgYXMgYW55KS5jb250ZW50WzBdLnRleHQsIFwiTTAwMVwiKTtcbiAgICAgIGFzc2VydC5vayghZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpKSwgXCJJRCBnZW5lcmF0aW9uIHNob3VsZCBub3QgY3JlYXRlIGEgbWlsZXN0b25lIGRpclwiKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuXG4gICAgICBjb25zdCBzZWNvbmQgPSBhd2FpdCB0b29sIS5oYW5kbGVyKHsgcHJvamVjdERpcjogYmFzZSB9KTtcbiAgICAgIGFzc2VydC5lcXVhbCgoc2Vjb25kIGFzIGFueSkuY29udGVudFswXS50ZXh0LCBcIk0wMDJcIik7XG5cbiAgICAgIGNvbnN0IHJvd3MgPSBfZ2V0QWRhcHRlcigpIVxuICAgICAgICAucHJlcGFyZShcIlNFTEVDVCBpZCBGUk9NIG1pbGVzdG9uZXMgT1JERVIgQlkgaWRcIilcbiAgICAgICAgLmFsbCgpIGFzIEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PjtcbiAgICAgIGFzc2VydC5kZWVwRXF1YWwocm93cy5tYXAoKHJvdykgPT4gcm93W1wiaWRcIl0pLCBbXCJNMDAxXCIsIFwiTTAwMlwiXSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICBpdChcImdzZF9wbGFuX3Rhc2sgcmVvcGVucyB0aGUgREIgYmVmb3JlIGlubGluZSB0YXNrIHBsYW5uaW5nIHdyaXRlc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHNlcnZlciA9IG1ha2VNb2NrU2VydmVyKCk7XG4gICAgICByZWdpc3RlcldvcmtmbG93VG9vbHMoc2VydmVyIGFzIGFueSk7XG4gICAgICBjb25zdCBtaWxlc3RvbmVUb29sID0gc2VydmVyLnRvb2xzLmZpbmQoKHQpID0+IHQubmFtZSA9PT0gXCJnc2RfcGxhbl9taWxlc3RvbmVcIik7XG4gICAgICBjb25zdCBzbGljZVRvb2wgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF9wbGFuX3NsaWNlXCIpO1xuICAgICAgY29uc3QgdGFza1Rvb2wgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF9wbGFuX3Rhc2tcIik7XG4gICAgICBhc3NlcnQub2sobWlsZXN0b25lVG9vbCwgXCJtaWxlc3RvbmUgcGxhbm5pbmcgdG9vbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcbiAgICAgIGFzc2VydC5vayhzbGljZVRvb2wsIFwic2xpY2UgcGxhbm5pbmcgdG9vbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcbiAgICAgIGFzc2VydC5vayh0YXNrVG9vbCwgXCJ0YXNrIHBsYW5uaW5nIHRvb2wgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG5cbiAgICAgIGF3YWl0IG1pbGVzdG9uZVRvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDEwXCIsXG4gICAgICAgIHRpdGxlOiBcIklubGluZSB0YXNrIHBsYW5uaW5nIERCIHJlb3BlblwiLFxuICAgICAgICB2aXNpb246IFwiU2VlZCBhIHNsaWNlLCBjbG9zZSB0aGUgREIsIHRoZW4gcGxhbiBhbm90aGVyIHRhc2sgaW5saW5lLlwiLFxuICAgICAgICBzbGljZXM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBzbGljZUlkOiBcIlMxMFwiLFxuICAgICAgICAgICAgdGl0bGU6IFwiSW5saW5lIHRhc2sgcGxhbm5pbmdcIixcbiAgICAgICAgICAgIHJpc2s6IFwibWVkaXVtXCIsXG4gICAgICAgICAgICBkZXBlbmRzOiBbXSxcbiAgICAgICAgICAgIGRlbW86IFwiSW5saW5lIGdzZF9wbGFuX3Rhc2sgcmVvcGVucyB0aGUgREIgYWZ0ZXIgaXQgd2FzIGNsb3NlZC5cIixcbiAgICAgICAgICAgIGdvYWw6IFwiUHJlc2VydmUgTUNQIHRhc2sgcGxhbm5pbmcgYWZ0ZXIgdGhlIERCIGFkYXB0ZXIgaXMgY2xvc2VkLlwiLFxuICAgICAgICAgICAgc3VjY2Vzc0NyaXRlcmlhOiBcIlRoZSBzZWNvbmQgdGFzayBwbGFuIHBlcnNpc3RzIGFmdGVyIGEgY2xvc2VkIERCIGlzIHJlb3BlbmVkLlwiLFxuICAgICAgICAgICAgcHJvb2ZMZXZlbDogXCJpbnRlZ3JhdGlvblwiLFxuICAgICAgICAgICAgaW50ZWdyYXRpb25DbG9zdXJlOiBcIlRoZSBpbmxpbmUgTUNQIGhhbmRsZXIgcmVvcGVucyB0aGUgREIgYmVmb3JlIHBsYW5uaW5nLlwiLFxuICAgICAgICAgICAgb2JzZXJ2YWJpbGl0eUltcGFjdDogXCJ3b3JrZmxvdy10b29scyBNQ1AgdGVzdHMgY292ZXIgdGhlIGlubGluZSByZW9wZW4gcGF0aC5cIixcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgICBhd2FpdCBzbGljZVRvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDEwXCIsXG4gICAgICAgIHNsaWNlSWQ6IFwiUzEwXCIsXG4gICAgICAgIGdvYWw6IFwiQ3JlYXRlIHRoZSBpbml0aWFsIHNsaWNlIHBsYW4gYmVmb3JlIGNsb3NpbmcgdGhlIERCLlwiLFxuICAgICAgICB0YXNrczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIHRhc2tJZDogXCJUMTBcIixcbiAgICAgICAgICAgIHRpdGxlOiBcIlNlZWQgZXhpc3RpbmcgdGFza1wiLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246IFwiQ3JlYXRlIHRoZSBpbml0aWFsIHRhc2sgcGxhbiBiZWZvcmUgY2xvc2luZyB0aGUgREIuXCIsXG4gICAgICAgICAgICBlc3RpbWF0ZTogXCI1bVwiLFxuICAgICAgICAgICAgZmlsZXM6IFtcInBhY2thZ2VzL21jcC1zZXJ2ZXIvc3JjL3dvcmtmbG93LXRvb2xzLnRzXCJdLFxuICAgICAgICAgICAgdmVyaWZ5OiBcIm5vZGUgLS10ZXN0XCIsXG4gICAgICAgICAgICBpbnB1dHM6IFtcIk0wMTAtUk9BRE1BUC5tZFwiXSxcbiAgICAgICAgICAgIGV4cGVjdGVkT3V0cHV0OiBbXCJUMTAtUExBTi5tZFwiXSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG5cbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGFza1Rvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDEwXCIsXG4gICAgICAgIHNsaWNlSWQ6IFwiUzEwXCIsXG4gICAgICAgIHRhc2tJZDogXCJUMTFcIixcbiAgICAgICAgdGl0bGU6IFwiUmVvcGVuIGFuZCBwbGFuXCIsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBcIkV4ZXJjaXNlIHRoZSBpbmxpbmUgcGxhbi10YXNrIHBhdGggYWZ0ZXIgdGhlIERCIHdhcyBjbG9zZWQuXCIsXG4gICAgICAgIGVzdGltYXRlOiBcIjVtXCIsXG4gICAgICAgIGZpbGVzOiBbXCJwYWNrYWdlcy9tY3Atc2VydmVyL3NyYy93b3JrZmxvdy10b29scy50c1wiXSxcbiAgICAgICAgdmVyaWZ5OiBcIm5vZGUgLS10ZXN0XCIsXG4gICAgICAgIGlucHV0czogW1wiTTAxMC1ST0FETUFQLm1kXCIsIFwiUzEwLVBMQU4ubWRcIl0sXG4gICAgICAgIGV4cGVjdGVkT3V0cHV0OiBbXCJUMTEtUExBTi5tZFwiXSxcbiAgICAgIH0pO1xuXG4gICAgICBhc3NlcnQubWF0Y2goKHJlc3VsdCBhcyBhbnkpLmNvbnRlbnRbMF0udGV4dCBhcyBzdHJpbmcsIC9QbGFubmVkIHRhc2sgVDExLyk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIGV4aXN0c1N5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAxMFwiLCBcInNsaWNlc1wiLCBcIlMxMFwiLCBcInRhc2tzXCIsIFwiVDExLVBMQU4ubWRcIikpLFxuICAgICAgICBcIlQxMSBwbGFuIHNob3VsZCBiZSB3cml0dGVuIGFmdGVyIHJlb3BlbmluZyB0aGUgREJcIixcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICBpdChcImdzZF9yZXBsYW5fc2xpY2UgYW5kIGdzZF9zbGljZV9yZXBsYW4gd29yayBlbmQtdG8tZW5kXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc2VydmVyID0gbWFrZU1vY2tTZXJ2ZXIoKTtcbiAgICAgIHJlZ2lzdGVyV29ya2Zsb3dUb29scyhzZXJ2ZXIgYXMgYW55KTtcbiAgICAgIGNvbnN0IG1pbGVzdG9uZVRvb2wgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF9wbGFuX21pbGVzdG9uZVwiKTtcbiAgICAgIGNvbnN0IHNsaWNlVG9vbCA9IHNlcnZlci50b29scy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09IFwiZ3NkX3BsYW5fc2xpY2VcIik7XG4gICAgICBjb25zdCB0YXNrVG9vbCA9IHNlcnZlci50b29scy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09IFwiZ3NkX3Rhc2tfY29tcGxldGVcIik7XG4gICAgICBjb25zdCBjYW5vbmljYWxUb29sID0gc2VydmVyLnRvb2xzLmZpbmQoKHQpID0+IHQubmFtZSA9PT0gXCJnc2RfcmVwbGFuX3NsaWNlXCIpO1xuICAgICAgY29uc3QgYWxpYXNUb29sID0gc2VydmVyLnRvb2xzLmZpbmQoKHQpID0+IHQubmFtZSA9PT0gXCJnc2Rfc2xpY2VfcmVwbGFuXCIpO1xuICAgICAgYXNzZXJ0Lm9rKG1pbGVzdG9uZVRvb2wsIFwibWlsZXN0b25lIHBsYW5uaW5nIHRvb2wgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG4gICAgICBhc3NlcnQub2soc2xpY2VUb29sLCBcInNsaWNlIHBsYW5uaW5nIHRvb2wgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG4gICAgICBhc3NlcnQub2sodGFza1Rvb2wsIFwidGFzayBjb21wbGV0aW9uIHRvb2wgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG4gICAgICBhc3NlcnQub2soY2Fub25pY2FsVG9vbCwgXCJzbGljZSByZXBsYW5uaW5nIHRvb2wgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG4gICAgICBhc3NlcnQub2soYWxpYXNUb29sLCBcInNsaWNlIHJlcGxhbm5pbmcgYWxpYXMgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG5cbiAgICAgIGF3YWl0IG1pbGVzdG9uZVRvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDk5XCIsXG4gICAgICAgIHRpdGxlOiBcIlNsaWNlIHJlcGxhbm5pbmdcIixcbiAgICAgICAgdmlzaW9uOiBcIkRyaXZlIHJlcGxhbiBwYXJpdHkgb3ZlciBNQ1AuXCIsXG4gICAgICAgIHNsaWNlczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIHNsaWNlSWQ6IFwiUzA5XCIsXG4gICAgICAgICAgICB0aXRsZTogXCJSZXBsYW4gc2xpY2VcIixcbiAgICAgICAgICAgIHJpc2s6IFwibWVkaXVtXCIsXG4gICAgICAgICAgICBkZXBlbmRzOiBbXSxcbiAgICAgICAgICAgIGRlbW86IFwiU2xpY2UgcmVwbGFucyBhZnRlciBhIGJsb2NrZXIgdGFzayBjb21wbGV0ZXMuXCIsXG4gICAgICAgICAgICBnb2FsOiBcIlByZXBhcmUgcmVwbGFuIHN0YXRlLlwiLFxuICAgICAgICAgICAgc3VjY2Vzc0NyaXRlcmlhOiBcIlBsYW4gYW5kIHJlcGxhbiBhcnRpZmFjdHMgdXBkYXRlIG92ZXIgTUNQLlwiLFxuICAgICAgICAgICAgcHJvb2ZMZXZlbDogXCJpbnRlZ3JhdGlvblwiLFxuICAgICAgICAgICAgaW50ZWdyYXRpb25DbG9zdXJlOiBcIlJlcGxhbiB1c2VzIHRoZSBzaGFyZWQgZXhlY3V0b3IgcGF0aC5cIixcbiAgICAgICAgICAgIG9ic2VydmFiaWxpdHlJbXBhY3Q6IFwiVGVzdHMgY292ZXIgcmVwbGFuIGFydGlmYWN0cy5cIixcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgICBhd2FpdCBzbGljZVRvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDk5XCIsXG4gICAgICAgIHNsaWNlSWQ6IFwiUzA5XCIsXG4gICAgICAgIGdvYWw6IFwiUGxhbiBhIHNsaWNlIHRoYXQgd2lsbCBiZSByZXBsYW5uZWQuXCIsXG4gICAgICAgIHRhc2tzOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgdGFza0lkOiBcIlQwOVwiLFxuICAgICAgICAgICAgdGl0bGU6IFwiQmxvY2tlciB0YXNrXCIsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogXCJGaW5pc2ggdGhlIGJsb2NrZXItZGlzY292ZXJ5IHRhc2suXCIsXG4gICAgICAgICAgICBlc3RpbWF0ZTogXCI1bVwiLFxuICAgICAgICAgICAgZmlsZXM6IFtcInNyYy9ibG9ja2VyLnRzXCJdLFxuICAgICAgICAgICAgdmVyaWZ5OiBcIm5vZGUgLS10ZXN0XCIsXG4gICAgICAgICAgICBpbnB1dHM6IFtcIk0wOTktUk9BRE1BUC5tZFwiXSxcbiAgICAgICAgICAgIGV4cGVjdGVkT3V0cHV0OiBbXCJUMDktU1VNTUFSWS5tZFwiXSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIHRhc2tJZDogXCJUMTBcIixcbiAgICAgICAgICAgIHRpdGxlOiBcIlBlbmRpbmcgdGFza1wiLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246IFwiT3JpZ2luYWwgZm9sbG93LXVwIHRhc2suXCIsXG4gICAgICAgICAgICBlc3RpbWF0ZTogXCIxMG1cIixcbiAgICAgICAgICAgIGZpbGVzOiBbXCJzcmMvcGVuZGluZy50c1wiXSxcbiAgICAgICAgICAgIHZlcmlmeTogXCJub2RlIC0tdGVzdFwiLFxuICAgICAgICAgICAgaW5wdXRzOiBbXCJTMDktUExBTi5tZFwiXSxcbiAgICAgICAgICAgIGV4cGVjdGVkT3V0cHV0OiBbXCJVcGRhdGVkIHBsYW5cIl0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgdGFza1Rvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDk5XCIsXG4gICAgICAgIHNsaWNlSWQ6IFwiUzA5XCIsXG4gICAgICAgIHRhc2tJZDogXCJUMDlcIixcbiAgICAgICAgb25lTGluZXI6IFwiQ29tcGxldGVkIGJsb2NrZXIgdGFza1wiLFxuICAgICAgICBuYXJyYXRpdmU6IFwiUHJlcGFyZWQgdGhlIHNsaWNlIGZvciByZXBsYW5uaW5nLlwiLFxuICAgICAgICB2ZXJpZmljYXRpb246IFwibm9kZSAtLXRlc3RcIixcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBjYW5vbmljYWxSZXN1bHQgPSBhd2FpdCBjYW5vbmljYWxUb29sIS5oYW5kbGVyKHtcbiAgICAgICAgcHJvamVjdERpcjogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTA5OVwiLFxuICAgICAgICBzbGljZUlkOiBcIlMwOVwiLFxuICAgICAgICBibG9ja2VyVGFza0lkOiBcIlQwOVwiLFxuICAgICAgICBibG9ja2VyRGVzY3JpcHRpb246IFwiT3JpZ2luYWwgYXBwcm9hY2ggaXMgbm8gbG9uZ2VyIHZpYWJsZS5cIixcbiAgICAgICAgd2hhdENoYW5nZWQ6IFwiVXBkYXRlZCB0aGUgcmVtYWluaW5nIHRhc2sgYW5kIGFkZGVkIHJlbWVkaWF0aW9uIHdvcmsuXCIsXG4gICAgICAgIHVwZGF0ZWRUYXNrczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIHRhc2tJZDogXCJUMTBcIixcbiAgICAgICAgICAgIHRpdGxlOiBcIlBlbmRpbmcgdGFzayAodXBkYXRlZClcIixcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIlVwZGF0ZWQgZm9sbG93LXVwIHRhc2sgYWZ0ZXIgcmVwbGFubmluZy5cIixcbiAgICAgICAgICAgIGVzdGltYXRlOiBcIjE1bVwiLFxuICAgICAgICAgICAgZmlsZXM6IFtcInNyYy9wZW5kaW5nLnRzXCIsIFwic3JjL3JlcGxhbm5lZC50c1wiXSxcbiAgICAgICAgICAgIHZlcmlmeTogXCJub2RlIC0tdGVzdFwiLFxuICAgICAgICAgICAgaW5wdXRzOiBbXCJTMDktUExBTi5tZFwiXSxcbiAgICAgICAgICAgIGV4cGVjdGVkT3V0cHV0OiBbXCJVcGRhdGVkIHBsYW5cIl0sXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICB0YXNrSWQ6IFwiVDExXCIsXG4gICAgICAgICAgICB0aXRsZTogXCJSZW1lZGlhdGlvbiB0YXNrXCIsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogXCJOZXcgdGFzayBpbnRyb2R1Y2VkIGJ5IHRoZSByZXBsYW4uXCIsXG4gICAgICAgICAgICBlc3RpbWF0ZTogXCIyMG1cIixcbiAgICAgICAgICAgIGZpbGVzOiBbXCJzcmMvcmVtZWRpYXRpb24udHNcIl0sXG4gICAgICAgICAgICB2ZXJpZnk6IFwibm9kZSAtLXRlc3RcIixcbiAgICAgICAgICAgIGlucHV0czogW1wiUzA5LVJFUExBTi5tZFwiXSxcbiAgICAgICAgICAgIGV4cGVjdGVkT3V0cHV0OiBbXCJSZW1lZGlhdGlvbiBwYXRjaFwiXSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgICByZW1vdmVkVGFza0lkczogW10sXG4gICAgICB9KTtcbiAgICAgIGFzc2VydC5tYXRjaCgoY2Fub25pY2FsUmVzdWx0IGFzIGFueSkuY29udGVudFswXS50ZXh0IGFzIHN0cmluZywgL1JlcGxhbm5lZCBzbGljZSBTMDkvKTtcblxuICAgICAgY29uc3QgYWxpYXNSZXN1bHQgPSBhd2FpdCBhbGlhc1Rvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDk5XCIsXG4gICAgICAgIHNsaWNlSWQ6IFwiUzA5XCIsXG4gICAgICAgIGJsb2NrZXJUYXNrSWQ6IFwiVDA5XCIsXG4gICAgICAgIGJsb2NrZXJEZXNjcmlwdGlvbjogXCJBbGlhcyBwYXRoIGNvbmZpcm1zIHRoZSBzYW1lIHJlcGxhbiBmbG93LlwiLFxuICAgICAgICB3aGF0Q2hhbmdlZDogXCJSZW1vdmVkIHRoZSByZW1lZGlhdGlvbiB0YXNrIGFmdGVyIHRoZSBhbGlhcyBjaGVjay5cIixcbiAgICAgICAgdXBkYXRlZFRhc2tzOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgdGFza0lkOiBcIlQxMFwiLFxuICAgICAgICAgICAgdGl0bGU6IFwiUGVuZGluZyB0YXNrICh1cGRhdGVkIGFnYWluKVwiLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246IFwiQWxpYXMgYWRqdXN0ZWQgdGhlIHJlbWFpbmluZyBwZW5kaW5nIHRhc2suXCIsXG4gICAgICAgICAgICBlc3RpbWF0ZTogXCIxMm1cIixcbiAgICAgICAgICAgIGZpbGVzOiBbXCJzcmMvcGVuZGluZy50c1wiXSxcbiAgICAgICAgICAgIHZlcmlmeTogXCJub2RlIC0tdGVzdFwiLFxuICAgICAgICAgICAgaW5wdXRzOiBbXCJTMDktUExBTi5tZFwiXSxcbiAgICAgICAgICAgIGV4cGVjdGVkT3V0cHV0OiBbXCJVcGRhdGVkIHBsYW5cIl0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgICAgcmVtb3ZlZFRhc2tJZHM6IFtcIlQxMVwiXSxcbiAgICAgIH0pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKChhbGlhc1Jlc3VsdCBhcyBhbnkpLmNvbnRlbnRbMF0udGV4dCBhcyBzdHJpbmcsIC9SZXBsYW5uZWQgc2xpY2UgUzA5Lyk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIGV4aXN0c1N5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTA5OVwiLCBcInNsaWNlc1wiLCBcIlMwOVwiLCBcIlMwOS1SRVBMQU4ubWRcIikpLFxuICAgICAgICBcInJlcGxhbiBhcnRpZmFjdCBzaG91bGQgZXhpc3Qgb24gZGlza1wiLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDk5XCIsIFwic2xpY2VzXCIsIFwiUzA5XCIsIFwiUzA5LVBMQU4ubWRcIikpLFxuICAgICAgICBcInVwZGF0ZWQgcGxhbiBzaG91bGQgZXhpc3Qgb24gZGlza1wiLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IHJlbW92ZWRUYXNrID0gX2dldEFkYXB0ZXIoKSEucHJlcGFyZShcbiAgICAgICAgXCJTRUxFQ1QgaWQgRlJPTSB0YXNrcyBXSEVSRSBtaWxlc3RvbmVfaWQgPSA/IEFORCBzbGljZV9pZCA9ID8gQU5EIGlkID0gP1wiLFxuICAgICAgKS5nZXQoXCJNMDk5XCIsIFwiUzA5XCIsIFwiVDExXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlbW92ZWRUYXNrLCB1bmRlZmluZWQsIFwiYWxpYXMgc2hvdWxkIHJlbW92ZSB0aGUgcmVwbGFubmVkIHRhc2tcIik7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICBpdChcImdzZF9zbGljZV9jb21wbGV0ZSBhbmQgZ3NkX2NvbXBsZXRlX3NsaWNlIHdvcmsgZW5kLXRvLWVuZFwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHNlcnZlciA9IG1ha2VNb2NrU2VydmVyKCk7XG4gICAgICByZWdpc3RlcldvcmtmbG93VG9vbHMoc2VydmVyIGFzIGFueSk7XG4gICAgICBjb25zdCBtaWxlc3RvbmVUb29sID0gc2VydmVyLnRvb2xzLmZpbmQoKHQpID0+IHQubmFtZSA9PT0gXCJnc2RfcGxhbl9taWxlc3RvbmVcIik7XG4gICAgICBjb25zdCBzbGljZVRvb2wgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF9wbGFuX3NsaWNlXCIpO1xuICAgICAgY29uc3QgdGFza1Rvb2wgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF90YXNrX2NvbXBsZXRlXCIpO1xuICAgICAgY29uc3QgY2Fub25pY2FsVG9vbCA9IHNlcnZlci50b29scy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09IFwiZ3NkX3NsaWNlX2NvbXBsZXRlXCIpO1xuICAgICAgY29uc3QgYWxpYXNUb29sID0gc2VydmVyLnRvb2xzLmZpbmQoKHQpID0+IHQubmFtZSA9PT0gXCJnc2RfY29tcGxldGVfc2xpY2VcIik7XG4gICAgICBhc3NlcnQub2sobWlsZXN0b25lVG9vbCwgXCJtaWxlc3RvbmUgcGxhbm5pbmcgdG9vbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcbiAgICAgIGFzc2VydC5vayhzbGljZVRvb2wsIFwic2xpY2UgcGxhbm5pbmcgdG9vbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcbiAgICAgIGFzc2VydC5vayh0YXNrVG9vbCwgXCJ0YXNrIGNvbXBsZXRpb24gdG9vbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcbiAgICAgIGFzc2VydC5vayhjYW5vbmljYWxUb29sLCBcInNsaWNlIGNvbXBsZXRpb24gdG9vbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcbiAgICAgIGFzc2VydC5vayhhbGlhc1Rvb2wsIFwic2xpY2UgY29tcGxldGlvbiBhbGlhcyBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcblxuICAgICAgYXdhaXQgbWlsZXN0b25lVG9vbCEuaGFuZGxlcih7XG4gICAgICAgIHByb2plY3REaXI6IGJhc2UsXG4gICAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDNcIixcbiAgICAgICAgdGl0bGU6IFwiRGVtbyBtaWxlc3RvbmVcIixcbiAgICAgICAgdmlzaW9uOiBcIlByZXBhcmUgY2Fub25pY2FsIHNsaWNlIGNvbXBsZXRpb24gc3RhdGUuXCIsXG4gICAgICAgIHNsaWNlczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIHNsaWNlSWQ6IFwiUzAzXCIsXG4gICAgICAgICAgICB0aXRsZTogXCJEZW1vIFNsaWNlXCIsXG4gICAgICAgICAgICByaXNrOiBcIm1lZGl1bVwiLFxuICAgICAgICAgICAgZGVwZW5kczogW10sXG4gICAgICAgICAgICBkZW1vOiBcIkNhbm9uaWNhbCBzbGljZSBjb21wbGV0ZXMgdGhyb3VnaCBNQ1AuXCIsXG4gICAgICAgICAgICBnb2FsOiBcIlNlZWQgd29ya2Zsb3cgc3RhdGUuXCIsXG4gICAgICAgICAgICBzdWNjZXNzQ3JpdGVyaWE6IFwiU2xpY2Ugc3VtbWFyeSBhbmQgVUFUIGZpbGVzIGFyZSB3cml0dGVuLlwiLFxuICAgICAgICAgICAgcHJvb2ZMZXZlbDogXCJpbnRlZ3JhdGlvblwiLFxuICAgICAgICAgICAgaW50ZWdyYXRpb25DbG9zdXJlOiBcIlBsYW5uaW5nIGFuZCBjb21wbGV0aW9uIHNoYXJlIHRoZSBNQ1AgYnJpZGdlLlwiLFxuICAgICAgICAgICAgb2JzZXJ2YWJpbGl0eUltcGFjdDogXCJXb3JrZmxvdyB0ZXN0cyBjb3ZlciBjYW5vbmljYWwgY29tcGxldGlvbi5cIixcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgICBhd2FpdCBzbGljZVRvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAzXCIsXG4gICAgICAgIHNsaWNlSWQ6IFwiUzAzXCIsXG4gICAgICAgIGdvYWw6IFwiQ29tcGxldGUgY2Fub25pY2FsIHNsaWNlIG92ZXIgTUNQLlwiLFxuICAgICAgICB0YXNrczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIHRhc2tJZDogXCJUMDNcIixcbiAgICAgICAgICAgIHRpdGxlOiBcIkNhbm9uaWNhbCB0YXNrXCIsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogXCJTZWVkIGEgY29tcGxldGVkIHRhc2sgZm9yIHNsaWNlIGNvbXBsZXRpb24uXCIsXG4gICAgICAgICAgICBlc3RpbWF0ZTogXCI1bVwiLFxuICAgICAgICAgICAgZmlsZXM6IFtcInBhY2thZ2VzL21jcC1zZXJ2ZXIvc3JjL3dvcmtmbG93LXRvb2xzLnRzXCJdLFxuICAgICAgICAgICAgdmVyaWZ5OiBcIm5vZGUgLS10ZXN0XCIsXG4gICAgICAgICAgICBpbnB1dHM6IFtcIk0wMDMtUk9BRE1BUC5tZFwiXSxcbiAgICAgICAgICAgIGV4cGVjdGVkT3V0cHV0OiBbXCJTMDMtU1VNTUFSWS5tZFwiLCBcIlMwMy1VQVQubWRcIl0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgdGFza1Rvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAzXCIsXG4gICAgICAgIHNsaWNlSWQ6IFwiUzAzXCIsXG4gICAgICAgIHRhc2tJZDogXCJUMDNcIixcbiAgICAgICAgb25lTGluZXI6IFwiQ29tcGxldGVkIGNhbm9uaWNhbCB0YXNrXCIsXG4gICAgICAgIG5hcnJhdGl2ZTogXCJQcmVwYXJlZCB0aGUgY2Fub25pY2FsIHNsaWNlIGZvciBjb21wbGV0aW9uLlwiLFxuICAgICAgICB2ZXJpZmljYXRpb246IFwibm9kZSAtLXRlc3RcIixcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBjYW5vbmljYWxSZXN1bHQgPSBhd2FpdCBjYW5vbmljYWxUb29sIS5oYW5kbGVyKHtcbiAgICAgICAgcHJvamVjdERpcjogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwM1wiLFxuICAgICAgICBzbGljZUlkOiBcIlMwM1wiLFxuICAgICAgICBzbGljZVRpdGxlOiBcIkRlbW8gU2xpY2VcIixcbiAgICAgICAgb25lTGluZXI6IFwiQ29tcGxldGVkIGNhbm9uaWNhbCBzbGljZVwiLFxuICAgICAgICBuYXJyYXRpdmU6IFwiRGlkIHRoZSBzbGljZSB3b3JrXCIsXG4gICAgICAgIHZlcmlmaWNhdGlvbjogXCJucG0gdGVzdFwiLFxuICAgICAgICB1YXRDb250ZW50OiBcIiMjIFVBVFxcblxcblBBU1NcIixcbiAgICAgIH0pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKChjYW5vbmljYWxSZXN1bHQgYXMgYW55KS5jb250ZW50WzBdLnRleHQgYXMgc3RyaW5nLCAvQ29tcGxldGVkIHNsaWNlIFMwMy8pO1xuXG4gICAgICBhd2FpdCBtaWxlc3RvbmVUb29sIS5oYW5kbGVyKHtcbiAgICAgICAgcHJvamVjdERpcjogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwNFwiLFxuICAgICAgICB0aXRsZTogXCJBbGlhcyBtaWxlc3RvbmVcIixcbiAgICAgICAgdmlzaW9uOiBcIlByZXBhcmUgYWxpYXMgc2xpY2UgY29tcGxldGlvbiBzdGF0ZS5cIixcbiAgICAgICAgc2xpY2VzOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgc2xpY2VJZDogXCJTMDRcIixcbiAgICAgICAgICAgIHRpdGxlOiBcIkFsaWFzIFNsaWNlXCIsXG4gICAgICAgICAgICByaXNrOiBcIm1lZGl1bVwiLFxuICAgICAgICAgICAgZGVwZW5kczogW10sXG4gICAgICAgICAgICBkZW1vOiBcIkFsaWFzIHNsaWNlIGNvbXBsZXRlcyB0aHJvdWdoIE1DUC5cIixcbiAgICAgICAgICAgIGdvYWw6IFwiU2VlZCBhbGlhcyB3b3JrZmxvdyBzdGF0ZS5cIixcbiAgICAgICAgICAgIHN1Y2Nlc3NDcml0ZXJpYTogXCJBbGlhcyBzdW1tYXJ5IGFuZCBVQVQgZmlsZXMgYXJlIHdyaXR0ZW4uXCIsXG4gICAgICAgICAgICBwcm9vZkxldmVsOiBcImludGVncmF0aW9uXCIsXG4gICAgICAgICAgICBpbnRlZ3JhdGlvbkNsb3N1cmU6IFwiQWxpYXMgcmVhY2hlcyB0aGUgc2hhcmVkIHNsaWNlIGV4ZWN1dG9yLlwiLFxuICAgICAgICAgICAgb2JzZXJ2YWJpbGl0eUltcGFjdDogXCJXb3JrZmxvdyB0ZXN0cyBjb3ZlciBhbGlhcyBjb21wbGV0aW9uLlwiLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICAgIGF3YWl0IHNsaWNlVG9vbCEuaGFuZGxlcih7XG4gICAgICAgIHByb2plY3REaXI6IGJhc2UsXG4gICAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDRcIixcbiAgICAgICAgc2xpY2VJZDogXCJTMDRcIixcbiAgICAgICAgZ29hbDogXCJDb21wbGV0ZSBhbGlhcyBzbGljZSBvdmVyIE1DUC5cIixcbiAgICAgICAgdGFza3M6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICB0YXNrSWQ6IFwiVDA0XCIsXG4gICAgICAgICAgICB0aXRsZTogXCJBbGlhcyB0YXNrXCIsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogXCJTZWVkIGEgY29tcGxldGVkIHRhc2sgZm9yIGFsaWFzIHNsaWNlIGNvbXBsZXRpb24uXCIsXG4gICAgICAgICAgICBlc3RpbWF0ZTogXCI1bVwiLFxuICAgICAgICAgICAgZmlsZXM6IFtcInBhY2thZ2VzL21jcC1zZXJ2ZXIvc3JjL3dvcmtmbG93LXRvb2xzLnRzXCJdLFxuICAgICAgICAgICAgdmVyaWZ5OiBcIm5vZGUgLS10ZXN0XCIsXG4gICAgICAgICAgICBpbnB1dHM6IFtcIk0wMDQtUk9BRE1BUC5tZFwiXSxcbiAgICAgICAgICAgIGV4cGVjdGVkT3V0cHV0OiBbXCJTMDQtU1VNTUFSWS5tZFwiLCBcIlMwNC1VQVQubWRcIl0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgdGFza1Rvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDA0XCIsXG4gICAgICAgIHNsaWNlSWQ6IFwiUzA0XCIsXG4gICAgICAgIHRhc2tJZDogXCJUMDRcIixcbiAgICAgICAgb25lTGluZXI6IFwiQ29tcGxldGVkIGFsaWFzIHRhc2tcIixcbiAgICAgICAgbmFycmF0aXZlOiBcIlByZXBhcmVkIHRoZSBhbGlhcyBzbGljZSBmb3IgY29tcGxldGlvbi5cIixcbiAgICAgICAgdmVyaWZpY2F0aW9uOiBcIm5vZGUgLS10ZXN0XCIsXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgYWxpYXNSZXN1bHQgPSBhd2FpdCBhbGlhc1Rvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDA0XCIsXG4gICAgICAgIHNsaWNlSWQ6IFwiUzA0XCIsXG4gICAgICAgIHNsaWNlVGl0bGU6IFwiQWxpYXMgU2xpY2VcIixcbiAgICAgICAgb25lTGluZXI6IFwiQ29tcGxldGVkIGFsaWFzIHNsaWNlXCIsXG4gICAgICAgIG5hcnJhdGl2ZTogXCJEaWQgdGhlIHNsaWNlIHdvcmsgdmlhIGFsaWFzXCIsXG4gICAgICAgIHZlcmlmaWNhdGlvbjogXCJucG0gdGVzdFwiLFxuICAgICAgICB1YXRDb250ZW50OiBcIiMjIFVBVFxcblxcblBBU1NcIixcbiAgICAgIH0pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKChhbGlhc1Jlc3VsdCBhcyBhbnkpLmNvbnRlbnRbMF0udGV4dCBhcyBzdHJpbmcsIC9Db21wbGV0ZWQgc2xpY2UgUzA0Lyk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIGV4aXN0c1N5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwNFwiLCBcInNsaWNlc1wiLCBcIlMwNFwiLCBcIlMwNC1TVU1NQVJZLm1kXCIpKSxcbiAgICAgICAgXCJhbGlhcyBzaG91bGQgd3JpdGUgc2xpY2Ugc3VtbWFyeSB0byBkaXNrXCIsXG4gICAgICApO1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBleGlzdHNTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDRcIiwgXCJzbGljZXNcIiwgXCJTMDRcIiwgXCJTMDQtVUFULm1kXCIpKSxcbiAgICAgICAgXCJhbGlhcyBzaG91bGQgd3JpdGUgc2xpY2UgVUFUIHRvIGRpc2tcIixcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICBpdChcImdzZF92YWxpZGF0ZV9taWxlc3RvbmUgYW5kIGdzZF9taWxlc3RvbmVfY29tcGxldGUgd29yayBlbmQtdG8tZW5kXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc2VydmVyID0gbWFrZU1vY2tTZXJ2ZXIoKTtcbiAgICAgIHJlZ2lzdGVyV29ya2Zsb3dUb29scyhzZXJ2ZXIgYXMgYW55KTtcbiAgICAgIGNvbnN0IG1pbGVzdG9uZVRvb2wgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF9wbGFuX21pbGVzdG9uZVwiKTtcbiAgICAgIGNvbnN0IHNsaWNlVG9vbCA9IHNlcnZlci50b29scy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09IFwiZ3NkX3BsYW5fc2xpY2VcIik7XG4gICAgICBjb25zdCB0YXNrVG9vbCA9IHNlcnZlci50b29scy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09IFwiZ3NkX3Rhc2tfY29tcGxldGVcIik7XG4gICAgICBjb25zdCBjb21wbGV0ZVNsaWNlVG9vbCA9IHNlcnZlci50b29scy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09IFwiZ3NkX3NsaWNlX2NvbXBsZXRlXCIpO1xuICAgICAgY29uc3QgdmFsaWRhdGVUb29sID0gc2VydmVyLnRvb2xzLmZpbmQoKHQpID0+IHQubmFtZSA9PT0gXCJnc2RfdmFsaWRhdGVfbWlsZXN0b25lXCIpO1xuICAgICAgY29uc3QgY29tcGxldGVNaWxlc3RvbmVBbGlhcyA9IHNlcnZlci50b29scy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09IFwiZ3NkX21pbGVzdG9uZV9jb21wbGV0ZVwiKTtcbiAgICAgIGFzc2VydC5vayhtaWxlc3RvbmVUb29sLCBcIm1pbGVzdG9uZSBwbGFubmluZyB0b29sIHNob3VsZCBiZSByZWdpc3RlcmVkXCIpO1xuICAgICAgYXNzZXJ0Lm9rKHNsaWNlVG9vbCwgXCJzbGljZSBwbGFubmluZyB0b29sIHNob3VsZCBiZSByZWdpc3RlcmVkXCIpO1xuICAgICAgYXNzZXJ0Lm9rKHRhc2tUb29sLCBcInRhc2sgY29tcGxldGlvbiB0b29sIHNob3VsZCBiZSByZWdpc3RlcmVkXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGNvbXBsZXRlU2xpY2VUb29sLCBcInNsaWNlIGNvbXBsZXRpb24gdG9vbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcbiAgICAgIGFzc2VydC5vayh2YWxpZGF0ZVRvb2wsIFwibWlsZXN0b25lIHZhbGlkYXRpb24gdG9vbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcbiAgICAgIGFzc2VydC5vayhjb21wbGV0ZU1pbGVzdG9uZUFsaWFzLCBcIm1pbGVzdG9uZSBjb21wbGV0aW9uIGFsaWFzIHNob3VsZCBiZSByZWdpc3RlcmVkXCIpO1xuXG4gICAgICBhd2FpdCBtaWxlc3RvbmVUb29sIS5oYW5kbGVyKHtcbiAgICAgICAgcHJvamVjdERpcjogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwNVwiLFxuICAgICAgICB0aXRsZTogXCJNaWxlc3RvbmUgbGlmZWN5Y2xlXCIsXG4gICAgICAgIHZpc2lvbjogXCJEcml2ZSB2YWxpZGF0aW9uIGFuZCBjb21wbGV0aW9uIG92ZXIgTUNQLlwiLFxuICAgICAgICBzbGljZXM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBzbGljZUlkOiBcIlMwNVwiLFxuICAgICAgICAgICAgdGl0bGU6IFwiTGlmZWN5Y2xlIHNsaWNlXCIsXG4gICAgICAgICAgICByaXNrOiBcIm1lZGl1bVwiLFxuICAgICAgICAgICAgZGVwZW5kczogW10sXG4gICAgICAgICAgICBkZW1vOiBcIk1pbGVzdG9uZSBjYW4gdmFsaWRhdGUgYW5kIGNvbXBsZXRlLlwiLFxuICAgICAgICAgICAgZ29hbDogXCJTZWVkIG1pbGVzdG9uZSBjb21wbGV0aW9uIHN0YXRlLlwiLFxuICAgICAgICAgICAgc3VjY2Vzc0NyaXRlcmlhOiBcIlN1bW1hcnkgYW5kIHZhbGlkYXRpb24gYXJ0aWZhY3RzIGFyZSB3cml0dGVuLlwiLFxuICAgICAgICAgICAgcHJvb2ZMZXZlbDogXCJpbnRlZ3JhdGlvblwiLFxuICAgICAgICAgICAgaW50ZWdyYXRpb25DbG9zdXJlOiBcIkxpZmVjeWNsZSB0b29scyBzaGFyZSB0aGUgTUNQIGJyaWRnZS5cIixcbiAgICAgICAgICAgIG9ic2VydmFiaWxpdHlJbXBhY3Q6IFwiVGVzdHMgY292ZXIgbWlsZXN0b25lIGVuZC10by1lbmQgYmVoYXZpb3IuXCIsXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgc2xpY2VUb29sIS5oYW5kbGVyKHtcbiAgICAgICAgcHJvamVjdERpcjogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwNVwiLFxuICAgICAgICBzbGljZUlkOiBcIlMwNVwiLFxuICAgICAgICBnb2FsOiBcIlByZXBhcmUgYSBjb21wbGV0ZSBtaWxlc3RvbmUuXCIsXG4gICAgICAgIHRhc2tzOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgdGFza0lkOiBcIlQwNVwiLFxuICAgICAgICAgICAgdGl0bGU6IFwiTGlmZWN5Y2xlIHRhc2tcIixcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIlNlZWQgYSBmdWxseSBjb21wbGV0ZWQgc2xpY2UuXCIsXG4gICAgICAgICAgICBlc3RpbWF0ZTogXCIxMG1cIixcbiAgICAgICAgICAgIGZpbGVzOiBbXCJwYWNrYWdlcy9tY3Atc2VydmVyL3NyYy93b3JrZmxvdy10b29scy50c1wiXSxcbiAgICAgICAgICAgIHZlcmlmeTogXCJub2RlIC0tdGVzdFwiLFxuICAgICAgICAgICAgaW5wdXRzOiBbXCJNMDA1LVJPQURNQVAubWRcIl0sXG4gICAgICAgICAgICBleHBlY3RlZE91dHB1dDogW1wiTTAwNS1WQUxJREFUSU9OLm1kXCIsIFwiTTAwNS1TVU1NQVJZLm1kXCJdLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICAgIGF3YWl0IHRhc2tUb29sIS5oYW5kbGVyKHtcbiAgICAgICAgcHJvamVjdERpcjogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwNVwiLFxuICAgICAgICBzbGljZUlkOiBcIlMwNVwiLFxuICAgICAgICB0YXNrSWQ6IFwiVDA1XCIsXG4gICAgICAgIG9uZUxpbmVyOiBcIkNvbXBsZXRlZCBsaWZlY3ljbGUgdGFza1wiLFxuICAgICAgICBuYXJyYXRpdmU6IFwiUHJlcGFyZWQgdGhlIG1pbGVzdG9uZSBmb3IgY2xvc3VyZS5cIixcbiAgICAgICAgdmVyaWZpY2F0aW9uOiBcIm5vZGUgLS10ZXN0XCIsXG4gICAgICB9KTtcbiAgICAgIGF3YWl0IGNvbXBsZXRlU2xpY2VUb29sIS5oYW5kbGVyKHtcbiAgICAgICAgcHJvamVjdERpcjogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwNVwiLFxuICAgICAgICBzbGljZUlkOiBcIlMwNVwiLFxuICAgICAgICBzbGljZVRpdGxlOiBcIkxpZmVjeWNsZSBTbGljZVwiLFxuICAgICAgICBvbmVMaW5lcjogXCJDb21wbGV0ZWQgbGlmZWN5Y2xlIHNsaWNlXCIsXG4gICAgICAgIG5hcnJhdGl2ZTogXCJDbG9zZWQgdGhlIG1pbGVzdG9uZSBzbGljZS5cIixcbiAgICAgICAgdmVyaWZpY2F0aW9uOiBcIm5vZGUgLS10ZXN0XCIsXG4gICAgICAgIHVhdENvbnRlbnQ6IFwiIyMgVUFUXFxuXFxuUEFTU1wiLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IHZhbGlkYXRpb25SZXN1bHQgPSBhd2FpdCB2YWxpZGF0ZVRvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDA1XCIsXG4gICAgICAgIHZlcmRpY3Q6IFwicGFzc1wiLFxuICAgICAgICByZW1lZGlhdGlvblJvdW5kOiAwLFxuICAgICAgICBzdWNjZXNzQ3JpdGVyaWFDaGVja2xpc3Q6IFwiLSBbeF0gTGlmZWN5Y2xlIHZlcmlmaWVkXCIsXG4gICAgICAgIHNsaWNlRGVsaXZlcnlBdWRpdDogXCJ8IFNsaWNlIHwgVmVyZGljdCB8XFxufCAtLS0gfCAtLS0gfFxcbnwgUzA1IHwgcGFzcyB8XCIsXG4gICAgICAgIGNyb3NzU2xpY2VJbnRlZ3JhdGlvbjogXCJObyBjcm9zcy1zbGljZSBtaXNtYXRjaGVzIGZvdW5kLlwiLFxuICAgICAgICByZXF1aXJlbWVudENvdmVyYWdlOiBcIk5vIHJlcXVpcmVtZW50IGdhcHMgcmVtYWluLlwiLFxuICAgICAgICB2ZXJkaWN0UmF0aW9uYWxlOiBcIlRoZSBtaWxlc3RvbmUgZGVsaXZlcmVkIGl0cyBzY29wZS5cIixcbiAgICAgIH0pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKCh2YWxpZGF0aW9uUmVzdWx0IGFzIGFueSkuY29udGVudFswXS50ZXh0IGFzIHN0cmluZywgL1ZhbGlkYXRlZCBtaWxlc3RvbmUgTTAwNS8pO1xuXG4gICAgICBjb25zdCBjb21wbGV0aW9uUmVzdWx0ID0gYXdhaXQgY29tcGxldGVNaWxlc3RvbmVBbGlhcyEuaGFuZGxlcih7XG4gICAgICAgIHByb2plY3REaXI6IGJhc2UsXG4gICAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDVcIixcbiAgICAgICAgdGl0bGU6IFwiTWlsZXN0b25lIGxpZmVjeWNsZVwiLFxuICAgICAgICBvbmVMaW5lcjogXCJNaWxlc3RvbmUgY2xvc2VkIHN1Y2Nlc3NmdWxseVwiLFxuICAgICAgICBuYXJyYXRpdmU6IFwiVmFsaWRhdGlvbiBwYXNzZWQgYW5kIGFsbCBzbGljZXMgd2VyZSBjb21wbGV0ZS5cIixcbiAgICAgICAgdmVyaWZpY2F0aW9uUGFzc2VkOiB0cnVlLFxuICAgICAgfSk7XG4gICAgICBhc3NlcnQubWF0Y2goKGNvbXBsZXRpb25SZXN1bHQgYXMgYW55KS5jb250ZW50WzBdLnRleHQgYXMgc3RyaW5nLCAvQ29tcGxldGVkIG1pbGVzdG9uZSBNMDA1Lyk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIGV4aXN0c1N5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwNVwiLCBcIk0wMDUtVkFMSURBVElPTi5tZFwiKSksXG4gICAgICAgIFwidmFsaWRhdGlvbiBhcnRpZmFjdCBzaG91bGQgZXhpc3Qgb24gZGlza1wiLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDA1XCIsIFwiTTAwNS1TVU1NQVJZLm1kXCIpKSxcbiAgICAgICAgXCJtaWxlc3RvbmUgc3VtbWFyeSBzaG91bGQgZXhpc3Qgb24gZGlza1wiLFxuICAgICAgKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwiZ3NkX3JlYXNzZXNzX3JvYWRtYXAsIGdzZF9yb2FkbWFwX3JlYXNzZXNzLCBhbmQgZ3NkX3NhdmVfZ2F0ZV9yZXN1bHQgd29yayBlbmQtdG8tZW5kXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc2VydmVyID0gbWFrZU1vY2tTZXJ2ZXIoKTtcbiAgICAgIHJlZ2lzdGVyV29ya2Zsb3dUb29scyhzZXJ2ZXIgYXMgYW55KTtcbiAgICAgIGNvbnN0IG1pbGVzdG9uZVRvb2wgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF9wbGFuX21pbGVzdG9uZVwiKTtcbiAgICAgIGNvbnN0IHNsaWNlVG9vbCA9IHNlcnZlci50b29scy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09IFwiZ3NkX3BsYW5fc2xpY2VcIik7XG4gICAgICBjb25zdCB0YXNrVG9vbCA9IHNlcnZlci50b29scy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09IFwiZ3NkX3Rhc2tfY29tcGxldGVcIik7XG4gICAgICBjb25zdCBjb21wbGV0ZVNsaWNlVG9vbCA9IHNlcnZlci50b29scy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09IFwiZ3NkX3NsaWNlX2NvbXBsZXRlXCIpO1xuICAgICAgY29uc3QgcmVhc3Nlc3NUb29sID0gc2VydmVyLnRvb2xzLmZpbmQoKHQpID0+IHQubmFtZSA9PT0gXCJnc2RfcmVhc3Nlc3Nfcm9hZG1hcFwiKTtcbiAgICAgIGNvbnN0IHJlYXNzZXNzQWxpYXMgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF9yb2FkbWFwX3JlYXNzZXNzXCIpO1xuICAgICAgY29uc3QgZ2F0ZVRvb2wgPSBzZXJ2ZXIudG9vbHMuZmluZCgodCkgPT4gdC5uYW1lID09PSBcImdzZF9zYXZlX2dhdGVfcmVzdWx0XCIpO1xuICAgICAgYXNzZXJ0Lm9rKG1pbGVzdG9uZVRvb2wsIFwibWlsZXN0b25lIHBsYW5uaW5nIHRvb2wgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG4gICAgICBhc3NlcnQub2soc2xpY2VUb29sLCBcInNsaWNlIHBsYW5uaW5nIHRvb2wgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG4gICAgICBhc3NlcnQub2sodGFza1Rvb2wsIFwidGFzayBjb21wbGV0aW9uIHRvb2wgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG4gICAgICBhc3NlcnQub2soY29tcGxldGVTbGljZVRvb2wsIFwic2xpY2UgY29tcGxldGlvbiB0b29sIHNob3VsZCBiZSByZWdpc3RlcmVkXCIpO1xuICAgICAgYXNzZXJ0Lm9rKHJlYXNzZXNzVG9vbCwgXCJyb2FkbWFwIHJlYXNzZXNzbWVudCB0b29sIHNob3VsZCBiZSByZWdpc3RlcmVkXCIpO1xuICAgICAgYXNzZXJ0Lm9rKHJlYXNzZXNzQWxpYXMsIFwicm9hZG1hcCByZWFzc2Vzc21lbnQgYWxpYXMgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG4gICAgICBhc3NlcnQub2soZ2F0ZVRvb2wsIFwiZ2F0ZSByZXN1bHQgdG9vbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcblxuICAgICAgYXdhaXQgbWlsZXN0b25lVG9vbCEuaGFuZGxlcih7XG4gICAgICAgIHByb2plY3REaXI6IGJhc2UsXG4gICAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDZcIixcbiAgICAgICAgdGl0bGU6IFwiUm9hZG1hcCByZWFzc2Vzc21lbnRcIixcbiAgICAgICAgdmlzaW9uOiBcIkRyaXZlIGdhdGUgcmVzdWx0cyBhbmQgcmVhc3Nlc3NtZW50IG92ZXIgTUNQLlwiLFxuICAgICAgICBzbGljZXM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBzbGljZUlkOiBcIlMwNlwiLFxuICAgICAgICAgICAgdGl0bGU6IFwiQ29tcGxldGVkIHNsaWNlXCIsXG4gICAgICAgICAgICByaXNrOiBcIm1lZGl1bVwiLFxuICAgICAgICAgICAgZGVwZW5kczogW10sXG4gICAgICAgICAgICBkZW1vOiBcIkNvbXBsZXRlZCBzbGljZSB0cmlnZ2VycyByZWFzc2Vzc21lbnQuXCIsXG4gICAgICAgICAgICBnb2FsOiBcIlNlZWQgcmVhc3Nlc3NtZW50IHN0YXRlLlwiLFxuICAgICAgICAgICAgc3VjY2Vzc0NyaXRlcmlhOiBcIkFzc2Vzc21lbnQgYW5kIHJvYWRtYXAgYXJ0aWZhY3RzIGFyZSB3cml0dGVuLlwiLFxuICAgICAgICAgICAgcHJvb2ZMZXZlbDogXCJpbnRlZ3JhdGlvblwiLFxuICAgICAgICAgICAgaW50ZWdyYXRpb25DbG9zdXJlOiBcIlJvYWRtYXAgdXBkYXRlcyBzaGFyZSB0aGUgTUNQIGJyaWRnZS5cIixcbiAgICAgICAgICAgIG9ic2VydmFiaWxpdHlJbXBhY3Q6IFwiVGVzdHMgY292ZXIgcmVhc3Nlc3NtZW50IGJlaGF2aW9yLlwiLFxuICAgICAgICAgIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgc2xpY2VJZDogXCJTMDdcIixcbiAgICAgICAgICAgIHRpdGxlOiBcIkZvbGxvdy11cCBzbGljZVwiLFxuICAgICAgICAgICAgcmlzazogXCJsb3dcIixcbiAgICAgICAgICAgIGRlcGVuZHM6IFtcIlMwNlwiXSxcbiAgICAgICAgICAgIGRlbW86IFwiRm9sbG93LXVwIHNsaWNlIHJlbWFpbnMgcGVuZGluZy5cIixcbiAgICAgICAgICAgIGdvYWw6IFwiTGVhdmUgcm9vbSBmb3Igcm9hZG1hcCBlZGl0cy5cIixcbiAgICAgICAgICAgIHN1Y2Nlc3NDcml0ZXJpYTogXCJSb2FkbWFwIG11dGF0aW9uIHN1Y2NlZWRzLlwiLFxuICAgICAgICAgICAgcHJvb2ZMZXZlbDogXCJpbnRlZ3JhdGlvblwiLFxuICAgICAgICAgICAgaW50ZWdyYXRpb25DbG9zdXJlOiBcIlBlbmRpbmcgc2xpY2UgY2FuIGJlIG1vZGlmaWVkIGFmdGVyIHJlYXNzZXNzbWVudC5cIixcbiAgICAgICAgICAgIG9ic2VydmFiaWxpdHlJbXBhY3Q6IFwiVGVzdHMgb2JzZXJ2ZSByb2FkbWFwIG11dGF0aW9uIG91dHB1dC5cIixcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgICBhd2FpdCBzbGljZVRvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDA2XCIsXG4gICAgICAgIHNsaWNlSWQ6IFwiUzA2XCIsXG4gICAgICAgIGdvYWw6IFwiQ29tcGxldGUgdGhlIGZpcnN0IHNsaWNlLlwiLFxuICAgICAgICB0YXNrczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIHRhc2tJZDogXCJUMDZcIixcbiAgICAgICAgICAgIHRpdGxlOiBcIlNlZWQgY29tcGxldGVkIHNsaWNlXCIsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogXCJQcmVwYXJlIGdhdGUgYW5kIHJlYXNzZXNzbWVudCBzdGF0ZS5cIixcbiAgICAgICAgICAgIGVzdGltYXRlOiBcIjEwbVwiLFxuICAgICAgICAgICAgZmlsZXM6IFtcInBhY2thZ2VzL21jcC1zZXJ2ZXIvc3JjL3dvcmtmbG93LXRvb2xzLnRzXCJdLFxuICAgICAgICAgICAgdmVyaWZ5OiBcIm5vZGUgLS10ZXN0XCIsXG4gICAgICAgICAgICBpbnB1dHM6IFtcIk0wMDYtUk9BRE1BUC5tZFwiXSxcbiAgICAgICAgICAgIGV4cGVjdGVkT3V0cHV0OiBbXCJTMDYtQVNTRVNTTUVOVC5tZFwiLCBcIk0wMDYtUk9BRE1BUC5tZFwiXSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IGdhdGVSZXN1bHQgPSBhd2FpdCBnYXRlVG9vbCEuaGFuZGxlcih7XG4gICAgICAgIHByb2plY3REaXI6IGJhc2UsXG4gICAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDZcIixcbiAgICAgICAgc2xpY2VJZDogXCJTMDZcIixcbiAgICAgICAgZ2F0ZUlkOiBcIlEzXCIsXG4gICAgICAgIHZlcmRpY3Q6IFwicGFzc1wiLFxuICAgICAgICByYXRpb25hbGU6IFwiVGhyZWF0IHN1cmZhY2UgaXMgY292ZXJlZC5cIixcbiAgICAgICAgZmluZGluZ3M6IFwiTm8gbmV3IGF0dGFjayBzdXJmYWNlIHdhcyBpbnRyb2R1Y2VkLlwiLFxuICAgICAgfSk7XG4gICAgICBhc3NlcnQubWF0Y2goKGdhdGVSZXN1bHQgYXMgYW55KS5jb250ZW50WzBdLnRleHQgYXMgc3RyaW5nLCAvR2F0ZSBRMyByZXN1bHQgc2F2ZWQvKTtcbiAgICAgIC8vICM0NDcyOiBleGVjdXRvciBgZGV0YWlsc2AgbXVzdCBiZSBhZGFwdGVkIHRvIE1DUCBgc3RydWN0dXJlZENvbnRlbnRgXG4gICAgICAvLyBzbyBpdCBzdXJ2aXZlcyB0aGUgcHJvdG9jb2wgdHJhbnNwb3J0IGludGFjdC4gQXNzZXJ0aW5nIHByb3BlcnR5XG4gICAgICAvLyAqYWJzZW5jZSogcmF0aGVyIHRoYW4gYD09PSB1bmRlZmluZWRgIHNvIGEgZnV0dXJlIHJlZ3Jlc3Npb24gdGhhdFxuICAgICAgLy8gZXhwbGljaXRseSBzZXRzIGBkZXRhaWxzOiB1bmRlZmluZWRgIChyYXRoZXIgdGhhbiByZW1vdmluZyBpdCkgc3RpbGxcbiAgICAgIC8vIGZhaWxzIHRoaXMgY29udHJhY3QgdGVzdC5cbiAgICAgIGFzc2VydC5lcXVhbChcbiAgICAgICAgT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGdhdGVSZXN1bHQsIFwiZGV0YWlsc1wiKSxcbiAgICAgICAgZmFsc2UsXG4gICAgICAgIFwiZXhlY3V0b3IgYGRldGFpbHNgIGZpZWxkIG11c3QgYmUgc3RyaXBwZWQgZnJvbSBNQ1AgdG9vbCByZXN1bHRcIixcbiAgICAgICk7XG4gICAgICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgICAgICAoZ2F0ZVJlc3VsdCBhcyBhbnkpLnN0cnVjdHVyZWRDb250ZW50LFxuICAgICAgICB7IG9wZXJhdGlvbjogXCJzYXZlX2dhdGVfcmVzdWx0XCIsIGdhdGVJZDogXCJRM1wiLCB2ZXJkaWN0OiBcInBhc3NcIiB9LFxuICAgICAgICBcImV4ZWN1dG9yIGRldGFpbHMgbXVzdCBiZSBmb3J3YXJkZWQgb24gdGhlIE1DUCBgc3RydWN0dXJlZENvbnRlbnRgIGNoYW5uZWxcIixcbiAgICAgICk7XG4gICAgICBjb25zdCBnYXRlUm93cyA9IF9nZXRBZGFwdGVyKCkhLnByZXBhcmUoXG4gICAgICAgIFwiU0VMRUNUIHN0YXR1cywgdmVyZGljdCwgcmF0aW9uYWxlIEZST00gcXVhbGl0eV9nYXRlcyBXSEVSRSBtaWxlc3RvbmVfaWQgPSA/IEFORCBzbGljZV9pZCA9ID8gQU5EIGdhdGVfaWQgPSA/XCIsXG4gICAgICApLmFsbChcIk0wMDZcIiwgXCJTMDZcIiwgXCJRM1wiKSBhcyBBcnJheTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj47XG4gICAgICBhc3NlcnQuZXF1YWwoZ2F0ZVJvd3MubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChnYXRlUm93c1swXVtcInN0YXR1c1wiXSwgXCJjb21wbGV0ZVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChnYXRlUm93c1swXVtcInZlcmRpY3RcIl0sIFwicGFzc1wiKTtcblxuICAgICAgYXdhaXQgdGFza1Rvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDA2XCIsXG4gICAgICAgIHNsaWNlSWQ6IFwiUzA2XCIsXG4gICAgICAgIHRhc2tJZDogXCJUMDZcIixcbiAgICAgICAgb25lTGluZXI6IFwiQ29tcGxldGVkIHJlYXNzZXNzbWVudCB0YXNrXCIsXG4gICAgICAgIG5hcnJhdGl2ZTogXCJQcmVwYXJlZCB0aGUgc2xpY2UgZm9yIHJlYXNzZXNzbWVudC5cIixcbiAgICAgICAgdmVyaWZpY2F0aW9uOiBcIm5vZGUgLS10ZXN0XCIsXG4gICAgICB9KTtcbiAgICAgIGF3YWl0IGNvbXBsZXRlU2xpY2VUb29sIS5oYW5kbGVyKHtcbiAgICAgICAgcHJvamVjdERpcjogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwNlwiLFxuICAgICAgICBzbGljZUlkOiBcIlMwNlwiLFxuICAgICAgICBzbGljZVRpdGxlOiBcIkNvbXBsZXRlZCBzbGljZVwiLFxuICAgICAgICBvbmVMaW5lcjogXCJDb21wbGV0ZWQgcmVhc3Nlc3NtZW50IHNsaWNlXCIsXG4gICAgICAgIG5hcnJhdGl2ZTogXCJDbG9zZWQgdGhlIGNvbXBsZXRlZCBzbGljZSBiZWZvcmUgcmVhc3Nlc3NtZW50LlwiLFxuICAgICAgICB2ZXJpZmljYXRpb246IFwibm9kZSAtLXRlc3RcIixcbiAgICAgICAgdWF0Q29udGVudDogXCIjIyBVQVRcXG5cXG5QQVNTXCIsXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgcmVhc3Nlc3NSZXN1bHQgPSBhd2FpdCByZWFzc2Vzc1Rvb2whLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDA2XCIsXG4gICAgICAgIGNvbXBsZXRlZFNsaWNlSWQ6IFwiUzA2XCIsXG4gICAgICAgIHZlcmRpY3Q6IFwicm9hZG1hcC1hZGp1c3RlZFwiLFxuICAgICAgICBhc3Nlc3NtZW50OiBcIkluc2VydCByZW1lZGlhdGlvbiB3b3JrIGFmdGVyIHRoZSBjb21wbGV0ZWQgc2xpY2UuXCIsXG4gICAgICAgIHNsaWNlQ2hhbmdlczoge1xuICAgICAgICAgIG1vZGlmaWVkOiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIHNsaWNlSWQ6IFwiUzA3XCIsXG4gICAgICAgICAgICAgIHRpdGxlOiBcIkZvbGxvdy11cCBzbGljZSAoYWRqdXN0ZWQpXCIsXG4gICAgICAgICAgICAgIHJpc2s6IFwibWVkaXVtXCIsXG4gICAgICAgICAgICAgIGRlcGVuZHM6IFtcIlMwNlwiXSxcbiAgICAgICAgICAgICAgZGVtbzogXCJBZGp1c3RlZCBkZW1vXCIsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgICAgYWRkZWQ6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgc2xpY2VJZDogXCJTMDhcIixcbiAgICAgICAgICAgICAgdGl0bGU6IFwiUmVtZWRpYXRpb24gc2xpY2VcIixcbiAgICAgICAgICAgICAgcmlzazogXCJoaWdoXCIsXG4gICAgICAgICAgICAgIGRlcGVuZHM6IFtcIlMwN1wiXSxcbiAgICAgICAgICAgICAgZGVtbzogXCJSZW1lZGlhdGlvbiBkZW1vXCIsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgICAgcmVtb3ZlZDogW10sXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIGFzc2VydC5tYXRjaCgocmVhc3Nlc3NSZXN1bHQgYXMgYW55KS5jb250ZW50WzBdLnRleHQgYXMgc3RyaW5nLCAvUmVhc3Nlc3NlZCByb2FkbWFwIGZvciBtaWxlc3RvbmUgTTAwNiBhZnRlciBTMDYvKTtcblxuICAgICAgY29uc3QgcmVhc3Nlc3NBbGlhc1Jlc3VsdCA9IGF3YWl0IHJlYXNzZXNzQWxpYXMhLmhhbmRsZXIoe1xuICAgICAgICBwcm9qZWN0RGlyOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDA2XCIsXG4gICAgICAgIGNvbXBsZXRlZFNsaWNlSWQ6IFwiUzA2XCIsXG4gICAgICAgIHZlcmRpY3Q6IFwicm9hZG1hcC1jb25maXJtZWRcIixcbiAgICAgICAgYXNzZXNzbWVudDogXCJObyBmdXJ0aGVyIGNoYW5nZXMgbmVlZGVkIGFmdGVyIHRoZSBmaXJzdCByZWFzc2Vzc21lbnQuXCIsXG4gICAgICAgIHNsaWNlQ2hhbmdlczoge1xuICAgICAgICAgIG1vZGlmaWVkOiBbXSxcbiAgICAgICAgICBhZGRlZDogW10sXG4gICAgICAgICAgcmVtb3ZlZDogW10sXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIGFzc2VydC5tYXRjaCgocmVhc3Nlc3NBbGlhc1Jlc3VsdCBhcyBhbnkpLmNvbnRlbnRbMF0udGV4dCBhcyBzdHJpbmcsIC9SZWFzc2Vzc2VkIHJvYWRtYXAgZm9yIG1pbGVzdG9uZSBNMDA2IGFmdGVyIFMwNi8pO1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBleGlzdHNTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDZcIiwgXCJzbGljZXNcIiwgXCJTMDZcIiwgXCJTMDYtQVNTRVNTTUVOVC5tZFwiKSksXG4gICAgICAgIFwiYXNzZXNzbWVudCBhcnRpZmFjdCBzaG91bGQgZXhpc3Qgb24gZGlza1wiLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDA2XCIsIFwiTTAwNi1ST0FETUFQLm1kXCIpKSxcbiAgICAgICAgXCJyb2FkbWFwIGFydGlmYWN0IHNob3VsZCBleGlzdCBvbiBkaXNrXCIsXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJVUkwgc2NoZW1lIHJlZ2V4IFx1MjAxNCBXaW5kb3dzIGRyaXZlIGxldHRlciBzYWZldHlcIiwgKCkgPT4ge1xuICAvLyBUaGlzIGlzIHRoZSByZWdleCB1c2VkIGluIGdldFdyaXRlR2F0ZU1vZHVsZUNhbmRpZGF0ZXMoKSBhbmRcbiAgLy8gZ2V0V29ya2Zsb3dFeGVjdXRvck1vZHVsZUNhbmRpZGF0ZXMoKSB0byByZWplY3Qgbm9uLWZpbGUgVVJMIHNjaGVtZXMuXG4gIC8vIEl0IG11c3QgTk9UIG1hdGNoIHNpbmdsZS1sZXR0ZXIgV2luZG93cyBkcml2ZSBwcmVmaXhlcyAoQzosIEQ6LCBldGMuKS5cbiAgY29uc3QgdXJsU2NoZW1lUmVnZXggPSAvXlthLXpdezIsfTovaTtcblxuICBpdChcInJlamVjdHMgbXVsdGktbGV0dGVyIFVSTCBzY2hlbWVzXCIsICgpID0+IHtcbiAgICBhc3NlcnQub2sodXJsU2NoZW1lUmVnZXgudGVzdChcImh0dHA6Ly9leGFtcGxlLmNvbVwiKSwgXCJodHRwOiBzaG91bGQgbWF0Y2hcIik7XG4gICAgYXNzZXJ0Lm9rKHVybFNjaGVtZVJlZ2V4LnRlc3QoXCJodHRwczovL2V4YW1wbGUuY29tXCIpLCBcImh0dHBzOiBzaG91bGQgbWF0Y2hcIik7XG4gICAgYXNzZXJ0Lm9rKHVybFNjaGVtZVJlZ2V4LnRlc3QoXCJmdHA6Ly9maWxlcy5leGFtcGxlLmNvbVwiKSwgXCJmdHA6IHNob3VsZCBtYXRjaFwiKTtcbiAgICBhc3NlcnQub2sodXJsU2NoZW1lUmVnZXgudGVzdChcImZpbGU6Ly8vQzovVXNlcnNcIiksIFwiZmlsZTogc2hvdWxkIG1hdGNoXCIpO1xuICAgIGFzc2VydC5vayh1cmxTY2hlbWVSZWdleC50ZXN0KFwibm9kZTpmc1wiKSwgXCJub2RlOiBzaG91bGQgbWF0Y2hcIik7XG4gIH0pO1xuXG4gIGl0KFwiYWxsb3dzIHNpbmdsZS1sZXR0ZXIgV2luZG93cyBkcml2ZSBwcmVmaXhlc1wiLCAoKSA9PiB7XG4gICAgYXNzZXJ0Lm9rKCF1cmxTY2hlbWVSZWdleC50ZXN0KFwiQzpcXFxcVXNlcnNcXFxcdXNlclxcXFxwcm9qZWN0XCIpLCBcIkM6XFxcXCBzaG91bGQgbm90IG1hdGNoXCIpO1xuICAgIGFzc2VydC5vayghdXJsU2NoZW1lUmVnZXgudGVzdChcIkQ6XFxcXG90aGVyXFxcXHBhdGhcIiksIFwiRDpcXFxcIHNob3VsZCBub3QgbWF0Y2hcIik7XG4gICAgYXNzZXJ0Lm9rKCF1cmxTY2hlbWVSZWdleC50ZXN0KFwiYzpcXFxcbG93ZXJjYXNlXFxcXGRyaXZlXCIpLCBcImM6XFxcXCBzaG91bGQgbm90IG1hdGNoXCIpO1xuICAgIGFzc2VydC5vayghdXJsU2NoZW1lUmVnZXgudGVzdChcIkU6L2ZvcndhcmQvc2xhc2gvcGF0aFwiKSwgXCJFOi8gc2hvdWxkIG5vdCBtYXRjaFwiKTtcbiAgfSk7XG5cbiAgaXQoXCJhbGxvd3MgYmFyZSBmaWxlc3lzdGVtIHBhdGhzXCIsICgpID0+IHtcbiAgICBhc3NlcnQub2soIXVybFNjaGVtZVJlZ2V4LnRlc3QoXCIvdXNyL2xvY2FsL2xpYi9tb2R1bGUuanNcIiksIFwidW5peCBhYnNvbHV0ZSBwYXRoIHNob3VsZCBub3QgbWF0Y2hcIik7XG4gICAgYXNzZXJ0Lm9rKCF1cmxTY2hlbWVSZWdleC50ZXN0KFwiLi9yZWxhdGl2ZS9wYXRoLmpzXCIpLCBcInJlbGF0aXZlIHBhdGggc2hvdWxkIG5vdCBtYXRjaFwiKTtcbiAgICBhc3NlcnQub2soIXVybFNjaGVtZVJlZ2V4LnRlc3QoXCIuLi9wYXJlbnQvcGF0aC5qc1wiKSwgXCJwYXJlbnQgcmVsYXRpdmUgcGF0aCBzaG91bGQgbm90IG1hdGNoXCIpO1xuICB9KTtcbn0pO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIHZhbGlkYXRlUHJvamVjdERpciBcdTIwMTQgc3ltbGluayBjb250YWlubWVudCBoYXJkZW5pbmcgKCM0NDc2KVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vL1xuLy8gVGhlIHJlZ3Jlc3Npb246IGEgc3ltbGluayBpbnNpZGUgdGhlIGFsbG93ZWQgcm9vdCBjb3VsZCBwb2ludCBvdXRzaWRlIGl0LFxuLy8gYW5kIGEgbGV4aWNhbC1vbmx5IGNvbnRhaW5tZW50IGNoZWNrIHdvdWxkIGhhcHBpbHkgYWRtaXQgdGhlIHBhdGguIFRoZSBmaXhcbi8vIHJlYWxwYXRoKClzIHRoZSBjYW5kaWRhdGUgKGFuZCB0aGUgYWxsb3dlZCByb290KSBiZWZvcmUgY2hlY2tpbmdcbi8vIGNvbnRhaW5tZW50LCBmYWxsaW5nIGJhY2sgdG8gdGhlIGxleGljYWwgcGF0aCBvbmx5IHdoZW4gdGhlIGNhbmRpZGF0ZVxuLy8gaXRzZWxmIGRvZXMgbm90IGV4aXN0IChhIGxlZ2l0aW1hdGUgYnJhbmQtbmV3LXdvcmt0cmVlIGNhc2UpLlxuXG5kZXNjcmliZShcInZhbGlkYXRlUHJvamVjdERpclwiLCAoKSA9PiB7XG4gIGl0KFwicmVqZWN0cyBhIHN5bWxpbmsgaW5zaWRlIHRoZSBhbGxvd2VkIHJvb3QgdGhhdCBwb2ludHMgb3V0c2lkZSBpdFwiLCAoKSA9PiB7XG4gICAgY29uc3QgYWxsb3dlZFJvb3QgPSBtYWtlVG1wQmFzZSgpO1xuICAgIGNvbnN0IG91dHNpZGUgPSBtYWtlVG1wQmFzZSgpO1xuICAgIGNvbnN0IGxpbmtJbnNpZGUgPSBqb2luKGFsbG93ZWRSb290LCBcImVzY2FwZS1saW5rXCIpO1xuICAgIHN5bWxpbmtTeW5jKG91dHNpZGUsIGxpbmtJbnNpZGUsIFwiZGlyXCIpO1xuXG4gICAgY29uc3QgcHJldlJvb3QgPSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUFJPSkVDVF9ST09UO1xuICAgIHRyeSB7XG4gICAgICBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUFJPSkVDVF9ST09UID0gYWxsb3dlZFJvb3Q7XG4gICAgICBhc3NlcnQudGhyb3dzKFxuICAgICAgICAoKSA9PiB2YWxpZGF0ZVByb2plY3REaXIobGlua0luc2lkZSksXG4gICAgICAgIC9jb25maWd1cmVkIHdvcmtmbG93IHByb2plY3Qgcm9vdC8sXG4gICAgICAgIFwic3ltbGluay10by1vdXRzaWRlIG11c3Qgbm90IGJ5cGFzcyB0aGUgY29udGFpbm1lbnQgY2hlY2tcIixcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGlmIChwcmV2Um9vdCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUFJPSkVDVF9ST09UO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX1BST0pFQ1RfUk9PVCA9IHByZXZSb290O1xuICAgICAgfVxuICAgICAgY2xlYW51cChhbGxvd2VkUm9vdCk7XG4gICAgICBjbGVhbnVwKG91dHNpZGUpO1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoXCJhY2NlcHRzIGEgbm9uLWV4aXN0ZW50IHBhdGggaW5zaWRlIHRoZSBhbGxvd2VkIHJvb3QgKG5ldyB3b3JrdHJlZSBjYXNlKVwiLCAoKSA9PiB7XG4gICAgY29uc3QgYWxsb3dlZFJvb3QgPSBtYWtlVG1wQmFzZSgpO1xuICAgIC8vIFVzZSB0aGUgcmVhbHBhdGggZm9ybSBzbyB0aGF0IG9uIHBsYXRmb3JtcyB3aGVyZSAvdG1wIHJlc29sdmVzIHRocm91Z2ggYVxuICAgIC8vIHN5bWxpbmsgKG1hY09TIC92YXIgXHUyMTkyIC9wcml2YXRlL3ZhcikgdGhlIGxleGljYWwgZmFsbGJhY2sgZm9yIEVOT0VOVFxuICAgIC8vIGNhbmRpZGF0ZXMgc3RpbGwgbGluZXMgdXAgd2l0aCB0aGUgYWxsb3dlZCByb290LlxuICAgIGNvbnN0IGNhbm9uaWNhbFJvb3QgPSByZWFscGF0aFN5bmMoYWxsb3dlZFJvb3QpO1xuICAgIGNvbnN0IGZ1dHVyZVdvcmt0cmVlID0gam9pbihjYW5vbmljYWxSb290LCBcIndvcmt0cmVlc1wiLCBcIk05OTktbm90LXlldC1jcmVhdGVkXCIpO1xuXG4gICAgY29uc3QgcHJldlJvb3QgPSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUFJPSkVDVF9ST09UO1xuICAgIHRyeSB7XG4gICAgICBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUFJPSkVDVF9ST09UID0gY2Fub25pY2FsUm9vdDtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlUHJvamVjdERpcihmdXR1cmVXb3JrdHJlZSk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBmdXR1cmVXb3JrdHJlZSwgXCJFTk9FTlQgc2hvdWxkIGZhbGwgYmFjayB0byB0aGUgbGV4aWNhbCBwYXRoLCBub3QgdGhyb3dcIik7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGlmIChwcmV2Um9vdCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUFJPSkVDVF9ST09UO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX1BST0pFQ1RfUk9PVCA9IHByZXZSb290O1xuICAgICAgfVxuICAgICAgY2xlYW51cChhbGxvd2VkUm9vdCk7XG4gICAgfVxuICB9KTtcblxuICBpdChcImFjY2VwdHMgYSByZWFsIGRpcmVjdG9yeSBpbnNpZGUgdGhlIGFsbG93ZWQgcm9vdFwiLCAoKSA9PiB7XG4gICAgY29uc3QgYWxsb3dlZFJvb3QgPSBtYWtlVG1wQmFzZSgpO1xuICAgIGNvbnN0IGNoaWxkID0gam9pbihhbGxvd2VkUm9vdCwgXCJjaGlsZFwiKTtcbiAgICBta2RpclN5bmMoY2hpbGQsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgY29uc3QgcHJldlJvb3QgPSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUFJPSkVDVF9ST09UO1xuICAgIHRyeSB7XG4gICAgICBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUFJPSkVDVF9ST09UID0gYWxsb3dlZFJvb3Q7XG4gICAgICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZVByb2plY3REaXIoY2hpbGQpO1xuICAgICAgLy8gcmVhbHBhdGggbWF5IGNhbm9uaWNhbGl6ZSBtYWNPUyAvdmFyIFx1MjE5MiAvcHJpdmF0ZS92YXI7IGFzc2VydCBpdCBlbmRzIHdpdGggb3VyIGNoaWxkIHNlZ21lbnQuXG4gICAgICBhc3NlcnQub2socmVzdWx0LmVuZHNXaXRoKFwiY2hpbGRcIiksIGBleHBlY3RlZCByZXNvbHZlZCBwYXRoIHRvIGVuZCB3aXRoICdjaGlsZCcsIGdvdCAke3Jlc3VsdH1gKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgaWYgKHByZXZSb290ID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QUk9KRUNUX1JPT1Q7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUFJPSkVDVF9ST09UID0gcHJldlJvb3Q7XG4gICAgICB9XG4gICAgICBjbGVhbnVwKGFsbG93ZWRSb290KTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwiYWNjZXB0cyBhIHdvcmt0cmVlIHVuZGVyIHRoZSBhbGxvd2VkIHJvb3QgZXh0ZXJuYWwgLmdzZCBzdGF0ZSB0YXJnZXRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGFsbG93ZWRSb290ID0gbWFrZVRtcEJhc2UoKTtcbiAgICBjb25zdCBleHRlcm5hbFN0YXRlID0gbWFrZVRtcEJhc2UoKTtcbiAgICBjb25zdCB3b3JrdHJlZSA9IGpvaW4oZXh0ZXJuYWxTdGF0ZSwgXCJ3b3JrdHJlZXNcIiwgXCJNMDAxXCIpO1xuICAgIG1rZGlyU3luYyh3b3JrdHJlZSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgcm1TeW5jKGpvaW4oYWxsb3dlZFJvb3QsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIHN5bWxpbmtTeW5jKGV4dGVybmFsU3RhdGUsIGpvaW4oYWxsb3dlZFJvb3QsIFwiLmdzZFwiKSwgXCJkaXJcIik7XG5cbiAgICBjb25zdCBwcmV2Um9vdCA9IHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QUk9KRUNUX1JPT1Q7XG4gICAgdHJ5IHtcbiAgICAgIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QUk9KRUNUX1JPT1QgPSBhbGxvd2VkUm9vdDtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlUHJvamVjdERpcih3b3JrdHJlZSk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCByZWFscGF0aFN5bmMod29ya3RyZWUpKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgaWYgKHByZXZSb290ID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QUk9KRUNUX1JPT1Q7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUFJPSkVDVF9ST09UID0gcHJldlJvb3Q7XG4gICAgICB9XG4gICAgICBjbGVhbnVwKGFsbG93ZWRSb290KTtcbiAgICAgIGNsZWFudXAoZXh0ZXJuYWxTdGF0ZSk7XG4gICAgfVxuICB9KTtcblxuICBpdChcInJlamVjdHMgZXh0ZXJuYWwtc3RhdGUgc2libGluZyBwYXRocyB0aGF0IG9ubHkgc2hhcmUgYSBwcmVmaXhcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGFsbG93ZWRSb290ID0gbWFrZVRtcEJhc2UoKTtcbiAgICBjb25zdCBleHRlcm5hbFN0YXRlID0gbWFrZVRtcEJhc2UoKTtcbiAgICBjb25zdCBzaWJsaW5nID0gYCR7ZXh0ZXJuYWxTdGF0ZX0tc2libGluZ2A7XG4gICAgY29uc3Qgc2libGluZ1dvcmt0cmVlID0gam9pbihzaWJsaW5nLCBcIndvcmt0cmVlc1wiLCBcIk0wMDFcIik7XG4gICAgbWtkaXJTeW5jKHNpYmxpbmdXb3JrdHJlZSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgcm1TeW5jKGpvaW4oYWxsb3dlZFJvb3QsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIHN5bWxpbmtTeW5jKGV4dGVybmFsU3RhdGUsIGpvaW4oYWxsb3dlZFJvb3QsIFwiLmdzZFwiKSwgXCJkaXJcIik7XG5cbiAgICBjb25zdCBwcmV2Um9vdCA9IHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QUk9KRUNUX1JPT1Q7XG4gICAgdHJ5IHtcbiAgICAgIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QUk9KRUNUX1JPT1QgPSBhbGxvd2VkUm9vdDtcbiAgICAgIGFzc2VydC50aHJvd3MoXG4gICAgICAgICgpID0+IHZhbGlkYXRlUHJvamVjdERpcihzaWJsaW5nV29ya3RyZWUpLFxuICAgICAgICAvY29uZmlndXJlZCB3b3JrZmxvdyBwcm9qZWN0IHJvb3QvLFxuICAgICAgKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgaWYgKHByZXZSb290ID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QUk9KRUNUX1JPT1Q7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUFJPSkVDVF9ST09UID0gcHJldlJvb3Q7XG4gICAgICB9XG4gICAgICBjbGVhbnVwKGFsbG93ZWRSb290KTtcbiAgICAgIGNsZWFudXAoZXh0ZXJuYWxTdGF0ZSk7XG4gICAgICBjbGVhbnVwKHNpYmxpbmcpO1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoXCJyZWplY3RzIHJlbGF0aXZlIHBhdGhzXCIsICgpID0+IHtcbiAgICBhc3NlcnQudGhyb3dzKFxuICAgICAgKCkgPT4gdmFsaWRhdGVQcm9qZWN0RGlyKFwicmVsYXRpdmUvcGF0aFwiKSxcbiAgICAgIC9tdXN0IGJlIGFuIGFic29sdXRlIHBhdGgvLFxuICAgICk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFHQSxTQUFTLFVBQVUsVUFBVTtBQUM3QixPQUFPLFlBQVk7QUFDbkIsU0FBUyxXQUFXLFFBQVEsZUFBZSxjQUFjLGtCQUFrQjtBQUMzRSxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsa0JBQWtCO0FBRTNCLFNBQVMsYUFBYSxvQkFBb0I7QUFFMUMsU0FBUyxhQUFhLHFCQUFxQjtBQUMzQyxTQUFTLHdCQUF3Qix1QkFBdUIscUJBQXFCLDBCQUEwQjtBQUV2RyxTQUFTLGNBQXNCO0FBQzdCLFFBQU0sT0FBTyxLQUFLLE9BQU8sR0FBRyxvQkFBb0IsV0FBVyxDQUFDLEVBQUU7QUFDOUQsWUFBVSxLQUFLLE1BQU0sTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDakQsU0FBTztBQUNUO0FBRUEsU0FBUyxRQUFRLE1BQW9CO0FBQ25DLE1BQUk7QUFDRixrQkFBYztBQUFBLEVB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
