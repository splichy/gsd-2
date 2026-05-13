import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  buildWorkflowMcpServers,
  detectWorkflowMcpLaunchConfig,
  getWorkflowTransportSupportError,
  getRequiredWorkflowToolsForAutoUnit,
  getRequiredWorkflowToolsForGuidedUnit,
  supportsStructuredQuestions,
  usesWorkflowMcpTransport
} from "../workflow-mcp.js";
function extractElicitPayload(request) {
  const payload = request.params ?? request;
  return payload;
}
test("guided execute-task requires canonical task completion tool", () => {
  assert.deepEqual(getRequiredWorkflowToolsForGuidedUnit("execute-task"), ["gsd_task_complete"]);
});
test("auto execute-task requires canonical task completion tool", () => {
  assert.deepEqual(getRequiredWorkflowToolsForAutoUnit("execute-task"), ["gsd_task_complete"]);
});
test("complete-slice requires closeout and execution handoff tools", () => {
  const expected = ["gsd_slice_complete", "gsd_task_reopen", "gsd_replan_slice"];
  assert.deepEqual(getRequiredWorkflowToolsForGuidedUnit("complete-slice"), expected);
  assert.deepEqual(getRequiredWorkflowToolsForAutoUnit("complete-slice"), expected);
});
test("deep project setup units declare required workflow MCP tools", () => {
  assert.deepEqual(getRequiredWorkflowToolsForGuidedUnit("discuss-project"), [
    "ask_user_questions",
    "gsd_summary_save"
  ]);
  assert.deepEqual(getRequiredWorkflowToolsForGuidedUnit("discuss-requirements"), [
    "ask_user_questions",
    "gsd_requirement_save",
    "gsd_summary_save"
  ]);
  assert.deepEqual(getRequiredWorkflowToolsForGuidedUnit("research-decision"), [
    "ask_user_questions"
  ]);
  assert.deepEqual(getRequiredWorkflowToolsForAutoUnit("discuss-project"), [
    "ask_user_questions",
    "gsd_summary_save"
  ]);
  assert.deepEqual(getRequiredWorkflowToolsForAutoUnit("discuss-requirements"), [
    "ask_user_questions",
    "gsd_requirement_save",
    "gsd_summary_save"
  ]);
  assert.deepEqual(getRequiredWorkflowToolsForAutoUnit("research-decision"), [
    "ask_user_questions"
  ]);
});
test("detectWorkflowMcpLaunchConfig prefers explicit env override", () => {
  const launch = detectWorkflowMcpLaunchConfig("/tmp/project", {
    GSD_WORKFLOW_MCP_NAME: "workflow-tools",
    GSD_WORKFLOW_MCP_COMMAND: "node",
    GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["dist/cli.js"]),
    GSD_WORKFLOW_MCP_ENV: JSON.stringify({ FOO: "bar" }),
    GSD_WORKFLOW_MCP_CWD: "/tmp/project",
    GSD_CLI_PATH: "/tmp/gsd"
  });
  assert.deepEqual(launch, {
    name: "workflow-tools",
    command: "node",
    args: ["dist/cli.js"],
    cwd: "/tmp/project",
    env: launch?.env
  });
  assert.equal(launch?.env?.FOO, "bar");
  assert.equal(launch?.env?.GSD_CLI_PATH, "/tmp/gsd");
  assert.equal(launch?.env?.GSD_BIN_PATH, "/tmp/gsd");
  assert.equal(launch?.env?.GSD_PERSIST_WRITE_GATE_STATE, "1");
  assert.equal(launch?.env?.GSD_WORKFLOW_PROJECT_ROOT, "/tmp/project");
  assert.match(launch?.env?.GSD_WORKFLOW_EXECUTORS_MODULE ?? "", /workflow-tool-executors\.(js|ts)$/);
  assert.match(launch?.env?.GSD_WORKFLOW_WRITE_GATE_MODULE ?? "", /write-gate\.(js|ts)$/);
});
test("detectWorkflowMcpLaunchConfig normalizes explicit workflow MCP env CLI aliases", () => {
  const binOnly = detectWorkflowMcpLaunchConfig("/tmp/project", {
    GSD_WORKFLOW_MCP_COMMAND: "node",
    GSD_WORKFLOW_MCP_ENV: JSON.stringify({ GSD_BIN_PATH: "/tmp/gsd-bin" })
  });
  assert.equal(binOnly?.env?.GSD_CLI_PATH, "/tmp/gsd-bin");
  assert.equal(binOnly?.env?.GSD_BIN_PATH, "/tmp/gsd-bin");
  const cliOnly = detectWorkflowMcpLaunchConfig("/tmp/project", {
    GSD_WORKFLOW_MCP_COMMAND: "node",
    GSD_WORKFLOW_MCP_ENV: JSON.stringify({ GSD_CLI_PATH: "/tmp/gsd-cli" })
  });
  assert.equal(cliOnly?.env?.GSD_CLI_PATH, "/tmp/gsd-cli");
  assert.equal(cliOnly?.env?.GSD_BIN_PATH, "/tmp/gsd-cli");
});
test("buildWorkflowMcpServers mirrors explicit launch config", () => {
  const servers = buildWorkflowMcpServers("/tmp/project", {
    GSD_WORKFLOW_MCP_COMMAND: "node",
    GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["dist/cli.js"])
  });
  assert.deepEqual(servers, {
    "gsd-workflow": {
      command: "node",
      args: ["dist/cli.js"],
      env: servers?.["gsd-workflow"]?.env
    }
  });
  assert.equal(servers?.["gsd-workflow"]?.env?.GSD_PERSIST_WRITE_GATE_STATE, "1");
  assert.equal(servers?.["gsd-workflow"]?.env?.GSD_WORKFLOW_PROJECT_ROOT, "/tmp/project");
  assert.match(servers?.["gsd-workflow"]?.env?.GSD_WORKFLOW_EXECUTORS_MODULE ?? "", /workflow-tool-executors\.(js|ts)$/);
  assert.match(servers?.["gsd-workflow"]?.env?.GSD_WORKFLOW_WRITE_GATE_MODULE ?? "", /write-gate\.(js|ts)$/);
});
test("detectWorkflowMcpLaunchConfig resolves the bundled server from GSD_PROJECT_ROOT", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "gsd-workflow-root-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "gsd-workflow-worktree-"));
  const cliPath = join(repoRoot, "packages", "mcp-server", "dist", "cli.js");
  mkdirSync(join(repoRoot, "packages", "mcp-server", "dist"), { recursive: true });
  writeFileSync(cliPath, "#!/usr/bin/env node\n", "utf-8");
  const launch = detectWorkflowMcpLaunchConfig(worktreeRoot, {
    GSD_PROJECT_ROOT: repoRoot
  });
  assert.deepEqual(launch, {
    name: "gsd-workflow",
    command: process.execPath,
    args: [cliPath],
    cwd: repoRoot,
    env: launch?.env
  });
  assert.equal(launch?.env?.GSD_PERSIST_WRITE_GATE_STATE, "1");
  assert.equal(launch?.env?.GSD_WORKFLOW_PROJECT_ROOT, repoRoot);
  assert.match(launch?.env?.GSD_WORKFLOW_EXECUTORS_MODULE ?? "", /workflow-tool-executors\.(js|ts)$/);
  assert.match(launch?.env?.GSD_WORKFLOW_WRITE_GATE_MODULE ?? "", /write-gate\.(js|ts)$/);
});
test("detectWorkflowMcpLaunchConfig resolves the bundled server from GSD_BIN_PATH ancestry", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "gsd-workflow-root-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "gsd-workflow-worktree-"));
  const cliPath = join(repoRoot, "packages", "mcp-server", "dist", "cli.js");
  const devCliPath = join(repoRoot, "scripts", "dev-cli.js");
  mkdirSync(join(repoRoot, "packages", "mcp-server", "dist"), { recursive: true });
  mkdirSync(join(repoRoot, "scripts"), { recursive: true });
  writeFileSync(cliPath, "#!/usr/bin/env node\n", "utf-8");
  writeFileSync(devCliPath, "#!/usr/bin/env node\n", "utf-8");
  const launch = detectWorkflowMcpLaunchConfig(worktreeRoot, {
    GSD_BIN_PATH: devCliPath
  });
  assert.deepEqual(launch, {
    name: "gsd-workflow",
    command: process.execPath,
    args: [cliPath],
    cwd: worktreeRoot,
    env: launch?.env
  });
  assert.equal(launch?.env?.GSD_CLI_PATH, devCliPath);
  assert.equal(launch?.env?.GSD_BIN_PATH, devCliPath);
  assert.equal(launch?.env?.GSD_PERSIST_WRITE_GATE_STATE, "1");
  assert.equal(launch?.env?.GSD_WORKFLOW_PROJECT_ROOT, worktreeRoot);
  assert.match(launch?.env?.GSD_WORKFLOW_EXECUTORS_MODULE ?? "", /workflow-tool-executors\.(js|ts)$/);
  assert.match(launch?.env?.GSD_WORKFLOW_WRITE_GATE_MODULE ?? "", /write-gate\.(js|ts)$/);
});
test("detectWorkflowMcpLaunchConfig resolves the bundled server relative to the installed GSD package", () => {
  const launch = detectWorkflowMcpLaunchConfig("/tmp/project", {
    GSD_BIN_PATH: "/tmp/gsd-loader.js"
  });
  assert.equal(launch?.command, process.execPath);
  assert.equal(launch?.cwd, "/tmp/project");
  assert.equal(launch?.env?.GSD_CLI_PATH, "/tmp/gsd-loader.js");
  assert.equal(launch?.env?.GSD_BIN_PATH, "/tmp/gsd-loader.js");
  assert.equal(launch?.env?.GSD_WORKFLOW_PROJECT_ROOT, "/tmp/project");
  assert.match(launch?.env?.GSD_WORKFLOW_EXECUTORS_MODULE ?? "", /workflow-tool-executors\.(js|ts)$/);
  assert.match(launch?.env?.GSD_WORKFLOW_WRITE_GATE_MODULE ?? "", /write-gate\.(js|ts)$/);
  assert.equal(typeof launch?.args?.[0], "string");
  assert.match(launch?.args?.[0] ?? "", /packages[\/\\]mcp-server[\/\\](dist[\/\\]cli\.js|src[\/\\]cli\.ts)$/);
  if ((launch?.args?.[0] ?? "").endsWith(".ts")) {
    assert.match(launch?.env?.NODE_OPTIONS ?? "", /--experimental-strip-types/);
    assert.match(launch?.env?.NODE_OPTIONS ?? "", /resolve-ts\.mjs/);
  }
});
test("detectWorkflowMcpLaunchConfig resolves the bundled server relative to the package without env hints", () => {
  const launch = detectWorkflowMcpLaunchConfig("/tmp/project", {});
  assert.equal(launch?.command, process.execPath);
  assert.equal(launch?.cwd, "/tmp/project");
  assert.equal(launch?.env?.GSD_CLI_PATH, void 0);
  assert.equal(launch?.env?.GSD_BIN_PATH, void 0);
  assert.equal(launch?.env?.GSD_WORKFLOW_PROJECT_ROOT, "/tmp/project");
  assert.match(launch?.env?.GSD_WORKFLOW_EXECUTORS_MODULE ?? "", /workflow-tool-executors\.(js|ts)$/);
  assert.match(launch?.env?.GSD_WORKFLOW_WRITE_GATE_MODULE ?? "", /write-gate\.(js|ts)$/);
  assert.equal(typeof launch?.args?.[0], "string");
  assert.match(launch?.args?.[0] ?? "", /packages[\/\\]mcp-server[\/\\](dist[\/\\]cli\.js|src[\/\\]cli\.ts)$/);
  if ((launch?.args?.[0] ?? "").endsWith(".ts")) {
    assert.match(launch?.env?.NODE_OPTIONS ?? "", /--experimental-strip-types/);
    assert.match(launch?.env?.NODE_OPTIONS ?? "", /resolve-ts\.mjs/);
  }
});
test("workflow MCP launch config reaches mutation tools over stdio", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-workflow-transport-"));
  mkdirSync(join(projectRoot, ".gsd"), { recursive: true });
  const isolatedGsdHome = mkdtempSync(join(tmpdir(), "gsd-workflow-home-"));
  const launch = detectWorkflowMcpLaunchConfig(projectRoot, {});
  assert.ok(launch, "expected a workflow MCP launch config");
  assert.match(
    launch.env?.GSD_WORKFLOW_EXECUTORS_MODULE ?? "",
    /(dist[\/\\]resources[\/\\]extensions[\/\\]gsd[\/\\]tools[\/\\]workflow-tool-executors\.js|src[\/\\]resources[\/\\]extensions[\/\\]gsd[\/\\]tools[\/\\]workflow-tool-executors\.(js|ts))$/
  );
  assert.match(
    launch.env?.GSD_WORKFLOW_WRITE_GATE_MODULE ?? "",
    /(dist[\/\\]resources[\/\\]extensions[\/\\]gsd[\/\\]bootstrap[\/\\]write-gate\.js|src[\/\\]resources[\/\\]extensions[\/\\]gsd[\/\\]bootstrap[\/\\]write-gate\.(js|ts))$/
  );
  if ((launch.env?.GSD_WORKFLOW_EXECUTORS_MODULE ?? "").endsWith(".ts")) {
    assert.match(launch.env?.NODE_OPTIONS ?? "", /--experimental-strip-types/);
    assert.match(launch.env?.NODE_OPTIONS ?? "", /resolve-ts\.mjs/);
  }
  const client = new Client(
    { name: "workflow-mcp-transport-test", version: "1.0.0" },
    { capabilities: { elicitation: {} } }
  );
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    const elicitation = extractElicitPayload(request);
    assert.match(elicitation.message, /Please answer the following question/);
    assert.ok(elicitation.requestedSchema.properties.transport_mode);
    assert.ok(elicitation.requestedSchema.properties["transport_mode__note"]);
    assert.ok(elicitation.requestedSchema.required?.includes("transport_mode"));
    return {
      action: "accept",
      content: {
        transport_mode: "None of the above",
        transport_mode__note: "Need Windows-safe MCP elicitation."
      }
    };
  });
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    env: {
      ...process.env,
      ...launch.env,
      GSD_HOME: isolatedGsdHome,
      DISCORD_BOT_TOKEN: "",
      SLACK_BOT_TOKEN: "",
      TELEGRAM_BOT_TOKEN: ""
    },
    cwd: launch.cwd,
    stderr: "pipe"
  });
  try {
    await client.connect(transport, { timeout: 3e4 });
    const tools = await client.listTools(void 0, { timeout: 3e4 });
    assert.ok(
      (tools.tools ?? []).some((tool) => tool.name === "gsd_plan_slice"),
      "expected workflow MCP surface to expose gsd_plan_slice"
    );
    assert.ok(
      (tools.tools ?? []).some((tool) => tool.name === "ask_user_questions"),
      "expected workflow MCP surface to expose ask_user_questions"
    );
    const askResult = await client.callTool(
      {
        name: "ask_user_questions",
        arguments: {
          questions: [
            {
              id: "transport_mode",
              header: "Transport",
              question: "How should the workflow prompt be delivered?",
              options: [
                { label: "Local UI", description: "Use the host tool UI." },
                { label: "Remote UI", description: "Use a remote response channel." }
              ]
            }
          ]
        }
      },
      void 0,
      { timeout: 3e4 }
    );
    assert.equal(askResult.isError, void 0);
    assert.equal(
      askResult.content?.[0]?.text ?? "",
      JSON.stringify({
        answers: {
          transport_mode: {
            answers: ["None of the above", "user_note: Need Windows-safe MCP elicitation."]
          }
        }
      })
    );
    const milestoneResult = await client.callTool(
      {
        name: "gsd_plan_milestone",
        arguments: {
          projectDir: projectRoot,
          milestoneId: "M001",
          title: "Transport planning",
          vision: "Verify stdio workflow MCP uses the executor bridge.",
          slices: [
            {
              sliceId: "S01",
              title: "Bridge path",
              risk: "low",
              depends: [],
              demo: "Milestone planning succeeds over stdio MCP.",
              goal: "Prove the executor bridge works in the spawned server.",
              successCriteria: "gsd_plan_slice can write plan artifacts.",
              proofLevel: "integration",
              integrationClosure: "Stdio MCP client reaches the workflow executor bridge.",
              observabilityImpact: "Regression test covers the spawned-server path."
            }
          ]
        }
      },
      void 0,
      { timeout: 3e4 }
    );
    assert.equal(milestoneResult.isError, void 0);
    assert.match(
      milestoneResult.content?.[0]?.text ?? "",
      /Planned milestone M001/
    );
    const sliceResult = await client.callTool(
      {
        name: "gsd_plan_slice",
        arguments: {
          projectDir: projectRoot,
          milestoneId: "M001",
          sliceId: "S01",
          goal: "Persist slice planning over the spawned MCP transport.",
          tasks: [
            {
              taskId: "T01",
              title: "Connect the bridge",
              description: "Ensure the workflow executor bridge resolves in the child process.",
              estimate: "10m",
              files: ["src/resources/extensions/gsd/workflow-mcp.ts"],
              verify: "node --test",
              inputs: [".gsd/milestones/M001/M001-ROADMAP.md"],
              expectedOutput: ["S01-PLAN.md", "T01-PLAN.md"]
            }
          ]
        }
      },
      void 0,
      { timeout: 3e4 }
    );
    assert.equal(sliceResult.isError, void 0);
    assert.match(
      sliceResult.content?.[0]?.text ?? "",
      /Planned slice S01/
    );
    assert.ok(
      existsSync(join(projectRoot, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md")),
      "expected slice plan artifact to be written through stdio MCP"
    );
    assert.ok(
      existsSync(
        join(projectRoot, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-PLAN.md")
      ),
      "expected task plan artifact to be written through stdio MCP"
    );
  } finally {
    await client.close().catch(() => {
    });
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(isolatedGsdHome, { recursive: true, force: true });
  }
});
test("workflow MCP ask_user_questions uses stdio elicitation round-trip", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-workflow-elicit-"));
  mkdirSync(join(projectRoot, ".gsd"), { recursive: true });
  const isolatedGsdHome = mkdtempSync(join(tmpdir(), "gsd-workflow-home-"));
  const launch = detectWorkflowMcpLaunchConfig(projectRoot, {});
  assert.ok(launch, "expected a workflow MCP launch config");
  const client = new Client(
    { name: "workflow-mcp-elicit-test", version: "1.0.0" },
    { capabilities: { elicitation: {} } }
  );
  let requestSeen = null;
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    const params = extractElicitPayload(request);
    requestSeen = params;
    return {
      action: "accept",
      content: {
        deployment: "None of the above",
        deployment__note: "Need hybrid deployment."
      }
    };
  });
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    env: {
      ...process.env,
      ...launch.env,
      GSD_HOME: isolatedGsdHome,
      DISCORD_BOT_TOKEN: "",
      SLACK_BOT_TOKEN: "",
      TELEGRAM_BOT_TOKEN: ""
    },
    cwd: launch.cwd,
    stderr: "pipe"
  });
  try {
    await client.connect(transport, { timeout: 3e4 });
    const result = await client.callTool(
      {
        name: "ask_user_questions",
        arguments: {
          questions: [
            {
              id: "deployment",
              header: "Deploy",
              question: "Where will this run?",
              options: [
                { label: "Cloud", description: "Managed hosting." },
                { label: "On-prem", description: "Runs in customer infrastructure." }
              ]
            }
          ]
        }
      },
      void 0,
      { timeout: 3e4 }
    );
    assert.ok(requestSeen, "expected stdio transport to forward an elicitation request");
    const seen = requestSeen;
    assert.match(seen.message, /Please answer the following question/);
    assert.ok(seen.requestedSchema.properties.deployment);
    assert.ok(seen.requestedSchema.properties.deployment__note);
    assert.ok(seen.requestedSchema.required?.includes("deployment"));
    const content = result.content;
    const text = content.find((item) => item.type === "text");
    assert.ok(text && "text" in text);
    assert.equal(
      text.text,
      JSON.stringify({
        answers: {
          deployment: {
            answers: ["None of the above", "user_note: Need hybrid deployment."]
          }
        }
      })
    );
  } finally {
    await client.close();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(isolatedGsdHome, { recursive: true, force: true });
  }
});
test("usesWorkflowMcpTransport matches local externalCli providers", () => {
  assert.equal(usesWorkflowMcpTransport("externalCli", "local://claude-code"), true);
  assert.equal(usesWorkflowMcpTransport("externalCli", "https://api.example.com"), false);
  assert.equal(usesWorkflowMcpTransport("oauth", "local://custom"), false);
});
test("supportsStructuredQuestions disables local workflow MCP questions unless explicitly enabled", () => {
  assert.equal(
    supportsStructuredQuestions(["ask_user_questions"], {
      authMode: "externalCli",
      baseUrl: "local://claude-code",
      env: {}
    }),
    false
  );
  assert.equal(
    supportsStructuredQuestions(["mcp__gsd-workflow__ask_user_questions"], {
      authMode: "externalCli",
      baseUrl: "local://claude-code",
      env: { GSD_WORKFLOW_MCP_STRUCTURED_QUESTIONS: "1" }
    }),
    true
  );
  assert.equal(
    supportsStructuredQuestions(["ask_user_questions"], {
      authMode: "oauth",
      baseUrl: "https://api.anthropic.com"
    }),
    true
  );
  assert.equal(
    supportsStructuredQuestions([], {
      authMode: "oauth",
      baseUrl: "https://api.anthropic.com"
    }),
    false
  );
});
test("transport compatibility passes when required tools fit current MCP surface", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    ["gsd_task_complete"],
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "guided flow",
      unitType: "execute-task",
      authMode: "externalCli",
      baseUrl: "local://claude-code"
    }
  );
  assert.equal(error, null);
});
test("transport compatibility discovers the bundled MCP server without env overrides", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    ["gsd_task_complete"],
    {
      projectRoot: "/tmp/project",
      env: {},
      surface: "auto-mode",
      unitType: "execute-task",
      authMode: "externalCli",
      baseUrl: "local://claude-code"
    }
  );
  assert.equal(error, null);
});
test("transport compatibility now allows auto execute-task over workflow MCP surface", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    ["gsd_complete_task"],
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "execute-task",
      authMode: "externalCli",
      baseUrl: "local://claude-code"
    }
  );
  assert.equal(error, null);
});
test("transport compatibility ignores API-backed providers", () => {
  const error = getWorkflowTransportSupportError(
    "openai-codex",
    ["gsd_plan_slice"],
    {
      projectRoot: "/tmp/project",
      env: {},
      surface: "auto-mode",
      unitType: "plan-slice",
      authMode: "oauth",
      baseUrl: "https://api.openai.com"
    }
  );
  assert.equal(error, null);
});
test("transport compatibility now allows plan-slice over workflow MCP surface", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    ["gsd_plan_slice"],
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "plan-slice",
      authMode: "externalCli",
      baseUrl: "local://claude-code"
    }
  );
  assert.equal(error, null);
});
test("transport compatibility now allows complete-slice over workflow MCP surface", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    ["gsd_complete_slice"],
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "complete-slice",
      authMode: "externalCli",
      baseUrl: "local://claude-code"
    }
  );
  assert.equal(error, null);
});
test("transport compatibility now allows reassess-roadmap over workflow MCP surface", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    ["gsd_milestone_status", "gsd_reassess_roadmap"],
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "reassess-roadmap",
      authMode: "externalCli",
      baseUrl: "local://claude-code"
    }
  );
  assert.equal(error, null);
});
test("transport compatibility now allows gate-evaluate over workflow MCP surface", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    ["gsd_save_gate_result"],
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "gate-evaluate",
      authMode: "externalCli",
      baseUrl: "local://claude-code"
    }
  );
  assert.equal(error, null);
});
test("transport compatibility now allows validate-milestone over workflow MCP surface", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    ["gsd_milestone_status", "gsd_validate_milestone"],
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "validate-milestone",
      authMode: "externalCli",
      baseUrl: "local://claude-code"
    }
  );
  assert.equal(error, null);
});
test("transport compatibility now allows complete-milestone over workflow MCP surface", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    ["gsd_milestone_status", "gsd_complete_milestone"],
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "complete-milestone",
      authMode: "externalCli",
      baseUrl: "local://claude-code"
    }
  );
  assert.equal(error, null);
});
test("transport compatibility now allows replan-slice over workflow MCP surface", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    ["gsd_replan_slice"],
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "replan-slice",
      authMode: "externalCli",
      baseUrl: "local://claude-code"
    }
  );
  assert.equal(error, null);
});
test("transport compatibility still blocks units whose MCP tools are not exposed", () => {
  const error = getWorkflowTransportSupportError(
    "claude-code",
    ["secure_env_collect"],
    {
      projectRoot: "/tmp/project",
      env: { GSD_WORKFLOW_MCP_COMMAND: "node" },
      surface: "auto-mode",
      unitType: "guided-discussion",
      authMode: "externalCli",
      baseUrl: "local://claude-code"
    }
  );
  assert.match(error ?? "", /requires secure_env_collect/);
  assert.match(error ?? "", /currently exposes only/);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrZmxvdy1tY3AudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBDbGllbnQgfSBmcm9tIFwiQG1vZGVsY29udGV4dHByb3RvY29sL3Nkay9jbGllbnQvaW5kZXguanNcIjtcbmltcG9ydCB7IFN0ZGlvQ2xpZW50VHJhbnNwb3J0IH0gZnJvbSBcIkBtb2RlbGNvbnRleHRwcm90b2NvbC9zZGsvY2xpZW50L3N0ZGlvLmpzXCI7XG5pbXBvcnQgeyBFbGljaXRSZXF1ZXN0U2NoZW1hIH0gZnJvbSBcIkBtb2RlbGNvbnRleHRwcm90b2NvbC9zZGsvdHlwZXMuanNcIjtcblxuaW1wb3J0IHtcbiAgYnVpbGRXb3JrZmxvd01jcFNlcnZlcnMsXG4gIGRldGVjdFdvcmtmbG93TWNwTGF1bmNoQ29uZmlnLFxuICBnZXRXb3JrZmxvd1RyYW5zcG9ydFN1cHBvcnRFcnJvcixcbiAgZ2V0UmVxdWlyZWRXb3JrZmxvd1Rvb2xzRm9yQXV0b1VuaXQsXG4gIGdldFJlcXVpcmVkV29ya2Zsb3dUb29sc0Zvckd1aWRlZFVuaXQsXG4gIHN1cHBvcnRzU3RydWN0dXJlZFF1ZXN0aW9ucyxcbiAgdXNlc1dvcmtmbG93TWNwVHJhbnNwb3J0LFxufSBmcm9tIFwiLi4vd29ya2Zsb3ctbWNwLnRzXCI7XG5cbnR5cGUgRWxpY2l0UGF5bG9hZCA9IHtcbiAgbWVzc2FnZTogc3RyaW5nO1xuICByZXF1ZXN0ZWRTY2hlbWE6IHsgcHJvcGVydGllczogUmVjb3JkPHN0cmluZywgdW5rbm93bj47IHJlcXVpcmVkPzogc3RyaW5nW10gfTtcbn07XG5cbmZ1bmN0aW9uIGV4dHJhY3RFbGljaXRQYXlsb2FkKHJlcXVlc3Q6IHVua25vd24pOiBFbGljaXRQYXlsb2FkIHtcbiAgY29uc3QgcGF5bG9hZCA9IChyZXF1ZXN0IGFzIHsgcGFyYW1zPzogdW5rbm93biB9KS5wYXJhbXMgPz8gcmVxdWVzdDtcbiAgcmV0dXJuIHBheWxvYWQgYXMgRWxpY2l0UGF5bG9hZDtcbn1cblxudGVzdChcImd1aWRlZCBleGVjdXRlLXRhc2sgcmVxdWlyZXMgY2Fub25pY2FsIHRhc2sgY29tcGxldGlvbiB0b29sXCIsICgpID0+IHtcbiAgYXNzZXJ0LmRlZXBFcXVhbChnZXRSZXF1aXJlZFdvcmtmbG93VG9vbHNGb3JHdWlkZWRVbml0KFwiZXhlY3V0ZS10YXNrXCIpLCBbXCJnc2RfdGFza19jb21wbGV0ZVwiXSk7XG59KTtcblxudGVzdChcImF1dG8gZXhlY3V0ZS10YXNrIHJlcXVpcmVzIGNhbm9uaWNhbCB0YXNrIGNvbXBsZXRpb24gdG9vbFwiLCAoKSA9PiB7XG4gIGFzc2VydC5kZWVwRXF1YWwoZ2V0UmVxdWlyZWRXb3JrZmxvd1Rvb2xzRm9yQXV0b1VuaXQoXCJleGVjdXRlLXRhc2tcIiksIFtcImdzZF90YXNrX2NvbXBsZXRlXCJdKTtcbn0pO1xuXG50ZXN0KFwiY29tcGxldGUtc2xpY2UgcmVxdWlyZXMgY2xvc2VvdXQgYW5kIGV4ZWN1dGlvbiBoYW5kb2ZmIHRvb2xzXCIsICgpID0+IHtcbiAgY29uc3QgZXhwZWN0ZWQgPSBbXCJnc2Rfc2xpY2VfY29tcGxldGVcIiwgXCJnc2RfdGFza19yZW9wZW5cIiwgXCJnc2RfcmVwbGFuX3NsaWNlXCJdO1xuICBhc3NlcnQuZGVlcEVxdWFsKGdldFJlcXVpcmVkV29ya2Zsb3dUb29sc0Zvckd1aWRlZFVuaXQoXCJjb21wbGV0ZS1zbGljZVwiKSwgZXhwZWN0ZWQpO1xuICBhc3NlcnQuZGVlcEVxdWFsKGdldFJlcXVpcmVkV29ya2Zsb3dUb29sc0ZvckF1dG9Vbml0KFwiY29tcGxldGUtc2xpY2VcIiksIGV4cGVjdGVkKTtcbn0pO1xuXG50ZXN0KFwiZGVlcCBwcm9qZWN0IHNldHVwIHVuaXRzIGRlY2xhcmUgcmVxdWlyZWQgd29ya2Zsb3cgTUNQIHRvb2xzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmRlZXBFcXVhbChnZXRSZXF1aXJlZFdvcmtmbG93VG9vbHNGb3JHdWlkZWRVbml0KFwiZGlzY3Vzcy1wcm9qZWN0XCIpLCBbXG4gICAgXCJhc2tfdXNlcl9xdWVzdGlvbnNcIixcbiAgICBcImdzZF9zdW1tYXJ5X3NhdmVcIixcbiAgXSk7XG4gIGFzc2VydC5kZWVwRXF1YWwoZ2V0UmVxdWlyZWRXb3JrZmxvd1Rvb2xzRm9yR3VpZGVkVW5pdChcImRpc2N1c3MtcmVxdWlyZW1lbnRzXCIpLCBbXG4gICAgXCJhc2tfdXNlcl9xdWVzdGlvbnNcIixcbiAgICBcImdzZF9yZXF1aXJlbWVudF9zYXZlXCIsXG4gICAgXCJnc2Rfc3VtbWFyeV9zYXZlXCIsXG4gIF0pO1xuICBhc3NlcnQuZGVlcEVxdWFsKGdldFJlcXVpcmVkV29ya2Zsb3dUb29sc0Zvckd1aWRlZFVuaXQoXCJyZXNlYXJjaC1kZWNpc2lvblwiKSwgW1xuICAgIFwiYXNrX3VzZXJfcXVlc3Rpb25zXCIsXG4gIF0pO1xuICBhc3NlcnQuZGVlcEVxdWFsKGdldFJlcXVpcmVkV29ya2Zsb3dUb29sc0ZvckF1dG9Vbml0KFwiZGlzY3Vzcy1wcm9qZWN0XCIpLCBbXG4gICAgXCJhc2tfdXNlcl9xdWVzdGlvbnNcIixcbiAgICBcImdzZF9zdW1tYXJ5X3NhdmVcIixcbiAgXSk7XG4gIGFzc2VydC5kZWVwRXF1YWwoZ2V0UmVxdWlyZWRXb3JrZmxvd1Rvb2xzRm9yQXV0b1VuaXQoXCJkaXNjdXNzLXJlcXVpcmVtZW50c1wiKSwgW1xuICAgIFwiYXNrX3VzZXJfcXVlc3Rpb25zXCIsXG4gICAgXCJnc2RfcmVxdWlyZW1lbnRfc2F2ZVwiLFxuICAgIFwiZ3NkX3N1bW1hcnlfc2F2ZVwiLFxuICBdKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChnZXRSZXF1aXJlZFdvcmtmbG93VG9vbHNGb3JBdXRvVW5pdChcInJlc2VhcmNoLWRlY2lzaW9uXCIpLCBbXG4gICAgXCJhc2tfdXNlcl9xdWVzdGlvbnNcIixcbiAgXSk7XG59KTtcblxudGVzdChcImRldGVjdFdvcmtmbG93TWNwTGF1bmNoQ29uZmlnIHByZWZlcnMgZXhwbGljaXQgZW52IG92ZXJyaWRlXCIsICgpID0+IHtcbiAgY29uc3QgbGF1bmNoID0gZGV0ZWN0V29ya2Zsb3dNY3BMYXVuY2hDb25maWcoXCIvdG1wL3Byb2plY3RcIiwge1xuICAgIEdTRF9XT1JLRkxPV19NQ1BfTkFNRTogXCJ3b3JrZmxvdy10b29sc1wiLFxuICAgIEdTRF9XT1JLRkxPV19NQ1BfQ09NTUFORDogXCJub2RlXCIsXG4gICAgR1NEX1dPUktGTE9XX01DUF9BUkdTOiBKU09OLnN0cmluZ2lmeShbXCJkaXN0L2NsaS5qc1wiXSksXG4gICAgR1NEX1dPUktGTE9XX01DUF9FTlY6IEpTT04uc3RyaW5naWZ5KHsgRk9POiBcImJhclwiIH0pLFxuICAgIEdTRF9XT1JLRkxPV19NQ1BfQ1dEOiBcIi90bXAvcHJvamVjdFwiLFxuICAgIEdTRF9DTElfUEFUSDogXCIvdG1wL2dzZFwiLFxuICB9KTtcblxuICBhc3NlcnQuZGVlcEVxdWFsKGxhdW5jaCwge1xuICAgIG5hbWU6IFwid29ya2Zsb3ctdG9vbHNcIixcbiAgICBjb21tYW5kOiBcIm5vZGVcIixcbiAgICBhcmdzOiBbXCJkaXN0L2NsaS5qc1wiXSxcbiAgICBjd2Q6IFwiL3RtcC9wcm9qZWN0XCIsXG4gICAgZW52OiBsYXVuY2g/LmVudixcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChsYXVuY2g/LmVudj8uRk9PLCBcImJhclwiKTtcbiAgYXNzZXJ0LmVxdWFsKGxhdW5jaD8uZW52Py5HU0RfQ0xJX1BBVEgsIFwiL3RtcC9nc2RcIik7XG4gIGFzc2VydC5lcXVhbChsYXVuY2g/LmVudj8uR1NEX0JJTl9QQVRILCBcIi90bXAvZ3NkXCIpO1xuICBhc3NlcnQuZXF1YWwobGF1bmNoPy5lbnY/LkdTRF9QRVJTSVNUX1dSSVRFX0dBVEVfU1RBVEUsIFwiMVwiKTtcbiAgYXNzZXJ0LmVxdWFsKGxhdW5jaD8uZW52Py5HU0RfV09SS0ZMT1dfUFJPSkVDVF9ST09ULCBcIi90bXAvcHJvamVjdFwiKTtcbiAgYXNzZXJ0Lm1hdGNoKGxhdW5jaD8uZW52Py5HU0RfV09SS0ZMT1dfRVhFQ1VUT1JTX01PRFVMRSA/PyBcIlwiLCAvd29ya2Zsb3ctdG9vbC1leGVjdXRvcnNcXC4oanN8dHMpJC8pO1xuICBhc3NlcnQubWF0Y2gobGF1bmNoPy5lbnY/LkdTRF9XT1JLRkxPV19XUklURV9HQVRFX01PRFVMRSA/PyBcIlwiLCAvd3JpdGUtZ2F0ZVxcLihqc3x0cykkLyk7XG59KTtcblxudGVzdChcImRldGVjdFdvcmtmbG93TWNwTGF1bmNoQ29uZmlnIG5vcm1hbGl6ZXMgZXhwbGljaXQgd29ya2Zsb3cgTUNQIGVudiBDTEkgYWxpYXNlc1wiLCAoKSA9PiB7XG4gIGNvbnN0IGJpbk9ubHkgPSBkZXRlY3RXb3JrZmxvd01jcExhdW5jaENvbmZpZyhcIi90bXAvcHJvamVjdFwiLCB7XG4gICAgR1NEX1dPUktGTE9XX01DUF9DT01NQU5EOiBcIm5vZGVcIixcbiAgICBHU0RfV09SS0ZMT1dfTUNQX0VOVjogSlNPTi5zdHJpbmdpZnkoeyBHU0RfQklOX1BBVEg6IFwiL3RtcC9nc2QtYmluXCIgfSksXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwoYmluT25seT8uZW52Py5HU0RfQ0xJX1BBVEgsIFwiL3RtcC9nc2QtYmluXCIpO1xuICBhc3NlcnQuZXF1YWwoYmluT25seT8uZW52Py5HU0RfQklOX1BBVEgsIFwiL3RtcC9nc2QtYmluXCIpO1xuXG4gIGNvbnN0IGNsaU9ubHkgPSBkZXRlY3RXb3JrZmxvd01jcExhdW5jaENvbmZpZyhcIi90bXAvcHJvamVjdFwiLCB7XG4gICAgR1NEX1dPUktGTE9XX01DUF9DT01NQU5EOiBcIm5vZGVcIixcbiAgICBHU0RfV09SS0ZMT1dfTUNQX0VOVjogSlNPTi5zdHJpbmdpZnkoeyBHU0RfQ0xJX1BBVEg6IFwiL3RtcC9nc2QtY2xpXCIgfSksXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwoY2xpT25seT8uZW52Py5HU0RfQ0xJX1BBVEgsIFwiL3RtcC9nc2QtY2xpXCIpO1xuICBhc3NlcnQuZXF1YWwoY2xpT25seT8uZW52Py5HU0RfQklOX1BBVEgsIFwiL3RtcC9nc2QtY2xpXCIpO1xufSk7XG5cbnRlc3QoXCJidWlsZFdvcmtmbG93TWNwU2VydmVycyBtaXJyb3JzIGV4cGxpY2l0IGxhdW5jaCBjb25maWdcIiwgKCkgPT4ge1xuICBjb25zdCBzZXJ2ZXJzID0gYnVpbGRXb3JrZmxvd01jcFNlcnZlcnMoXCIvdG1wL3Byb2plY3RcIiwge1xuICAgIEdTRF9XT1JLRkxPV19NQ1BfQ09NTUFORDogXCJub2RlXCIsXG4gICAgR1NEX1dPUktGTE9XX01DUF9BUkdTOiBKU09OLnN0cmluZ2lmeShbXCJkaXN0L2NsaS5qc1wiXSksXG4gIH0pO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwoc2VydmVycywge1xuICAgIFwiZ3NkLXdvcmtmbG93XCI6IHtcbiAgICAgIGNvbW1hbmQ6IFwibm9kZVwiLFxuICAgICAgYXJnczogW1wiZGlzdC9jbGkuanNcIl0sXG4gICAgICBlbnY6IHNlcnZlcnM/LltcImdzZC13b3JrZmxvd1wiXT8uZW52LFxuICAgIH0sXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwoKHNlcnZlcnM/LltcImdzZC13b3JrZmxvd1wiXT8uZW52IGFzIFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfCB1bmRlZmluZWQpPy5HU0RfUEVSU0lTVF9XUklURV9HQVRFX1NUQVRFLCBcIjFcIik7XG4gIGFzc2VydC5lcXVhbCgoc2VydmVycz8uW1wiZ3NkLXdvcmtmbG93XCJdPy5lbnYgYXMgUmVjb3JkPHN0cmluZywgc3RyaW5nPiB8IHVuZGVmaW5lZCk/LkdTRF9XT1JLRkxPV19QUk9KRUNUX1JPT1QsIFwiL3RtcC9wcm9qZWN0XCIpO1xuICBhc3NlcnQubWF0Y2goKHNlcnZlcnM/LltcImdzZC13b3JrZmxvd1wiXT8uZW52IGFzIFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfCB1bmRlZmluZWQpPy5HU0RfV09SS0ZMT1dfRVhFQ1VUT1JTX01PRFVMRSA/PyBcIlwiLCAvd29ya2Zsb3ctdG9vbC1leGVjdXRvcnNcXC4oanN8dHMpJC8pO1xuICBhc3NlcnQubWF0Y2goKHNlcnZlcnM/LltcImdzZC13b3JrZmxvd1wiXT8uZW52IGFzIFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfCB1bmRlZmluZWQpPy5HU0RfV09SS0ZMT1dfV1JJVEVfR0FURV9NT0RVTEUgPz8gXCJcIiwgL3dyaXRlLWdhdGVcXC4oanN8dHMpJC8pO1xufSk7XG5cbnRlc3QoXCJkZXRlY3RXb3JrZmxvd01jcExhdW5jaENvbmZpZyByZXNvbHZlcyB0aGUgYnVuZGxlZCBzZXJ2ZXIgZnJvbSBHU0RfUFJPSkVDVF9ST09UXCIsICgpID0+IHtcbiAgY29uc3QgcmVwb1Jvb3QgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC13b3JrZmxvdy1yb290LVwiKSk7XG4gIGNvbnN0IHdvcmt0cmVlUm9vdCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXdvcmtmbG93LXdvcmt0cmVlLVwiKSk7XG4gIGNvbnN0IGNsaVBhdGggPSBqb2luKHJlcG9Sb290LCBcInBhY2thZ2VzXCIsIFwibWNwLXNlcnZlclwiLCBcImRpc3RcIiwgXCJjbGkuanNcIik7XG5cbiAgbWtkaXJTeW5jKGpvaW4ocmVwb1Jvb3QsIFwicGFja2FnZXNcIiwgXCJtY3Atc2VydmVyXCIsIFwiZGlzdFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoY2xpUGF0aCwgXCIjIS91c3IvYmluL2VudiBub2RlXFxuXCIsIFwidXRmLThcIik7XG5cbiAgY29uc3QgbGF1bmNoID0gZGV0ZWN0V29ya2Zsb3dNY3BMYXVuY2hDb25maWcod29ya3RyZWVSb290LCB7XG4gICAgR1NEX1BST0pFQ1RfUk9PVDogcmVwb1Jvb3QsXG4gIH0pO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwobGF1bmNoLCB7XG4gICAgbmFtZTogXCJnc2Qtd29ya2Zsb3dcIixcbiAgICBjb21tYW5kOiBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgIGFyZ3M6IFtjbGlQYXRoXSxcbiAgICBjd2Q6IHJlcG9Sb290LFxuICAgIGVudjogbGF1bmNoPy5lbnYsXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwobGF1bmNoPy5lbnY/LkdTRF9QRVJTSVNUX1dSSVRFX0dBVEVfU1RBVEUsIFwiMVwiKTtcbiAgYXNzZXJ0LmVxdWFsKGxhdW5jaD8uZW52Py5HU0RfV09SS0ZMT1dfUFJPSkVDVF9ST09ULCByZXBvUm9vdCk7XG4gIGFzc2VydC5tYXRjaChsYXVuY2g/LmVudj8uR1NEX1dPUktGTE9XX0VYRUNVVE9SU19NT0RVTEUgPz8gXCJcIiwgL3dvcmtmbG93LXRvb2wtZXhlY3V0b3JzXFwuKGpzfHRzKSQvKTtcbiAgYXNzZXJ0Lm1hdGNoKGxhdW5jaD8uZW52Py5HU0RfV09SS0ZMT1dfV1JJVEVfR0FURV9NT0RVTEUgPz8gXCJcIiwgL3dyaXRlLWdhdGVcXC4oanN8dHMpJC8pO1xufSk7XG5cbnRlc3QoXCJkZXRlY3RXb3JrZmxvd01jcExhdW5jaENvbmZpZyByZXNvbHZlcyB0aGUgYnVuZGxlZCBzZXJ2ZXIgZnJvbSBHU0RfQklOX1BBVEggYW5jZXN0cnlcIiwgKCkgPT4ge1xuICBjb25zdCByZXBvUm9vdCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXdvcmtmbG93LXJvb3QtXCIpKTtcbiAgY29uc3Qgd29ya3RyZWVSb290ID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtd29ya2Zsb3ctd29ya3RyZWUtXCIpKTtcbiAgY29uc3QgY2xpUGF0aCA9IGpvaW4ocmVwb1Jvb3QsIFwicGFja2FnZXNcIiwgXCJtY3Atc2VydmVyXCIsIFwiZGlzdFwiLCBcImNsaS5qc1wiKTtcbiAgY29uc3QgZGV2Q2xpUGF0aCA9IGpvaW4ocmVwb1Jvb3QsIFwic2NyaXB0c1wiLCBcImRldi1jbGkuanNcIik7XG5cbiAgbWtkaXJTeW5jKGpvaW4ocmVwb1Jvb3QsIFwicGFja2FnZXNcIiwgXCJtY3Atc2VydmVyXCIsIFwiZGlzdFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIG1rZGlyU3luYyhqb2luKHJlcG9Sb290LCBcInNjcmlwdHNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGNsaVBhdGgsIFwiIyEvdXNyL2Jpbi9lbnYgbm9kZVxcblwiLCBcInV0Zi04XCIpO1xuICB3cml0ZUZpbGVTeW5jKGRldkNsaVBhdGgsIFwiIyEvdXNyL2Jpbi9lbnYgbm9kZVxcblwiLCBcInV0Zi04XCIpO1xuXG4gIGNvbnN0IGxhdW5jaCA9IGRldGVjdFdvcmtmbG93TWNwTGF1bmNoQ29uZmlnKHdvcmt0cmVlUm9vdCwge1xuICAgIEdTRF9CSU5fUEFUSDogZGV2Q2xpUGF0aCxcbiAgfSk7XG5cbiAgYXNzZXJ0LmRlZXBFcXVhbChsYXVuY2gsIHtcbiAgICBuYW1lOiBcImdzZC13b3JrZmxvd1wiLFxuICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgYXJnczogW2NsaVBhdGhdLFxuICAgIGN3ZDogd29ya3RyZWVSb290LFxuICAgIGVudjogbGF1bmNoPy5lbnYsXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwobGF1bmNoPy5lbnY/LkdTRF9DTElfUEFUSCwgZGV2Q2xpUGF0aCk7XG4gIGFzc2VydC5lcXVhbChsYXVuY2g/LmVudj8uR1NEX0JJTl9QQVRILCBkZXZDbGlQYXRoKTtcbiAgYXNzZXJ0LmVxdWFsKGxhdW5jaD8uZW52Py5HU0RfUEVSU0lTVF9XUklURV9HQVRFX1NUQVRFLCBcIjFcIik7XG4gIGFzc2VydC5lcXVhbChsYXVuY2g/LmVudj8uR1NEX1dPUktGTE9XX1BST0pFQ1RfUk9PVCwgd29ya3RyZWVSb290KTtcbiAgYXNzZXJ0Lm1hdGNoKGxhdW5jaD8uZW52Py5HU0RfV09SS0ZMT1dfRVhFQ1VUT1JTX01PRFVMRSA/PyBcIlwiLCAvd29ya2Zsb3ctdG9vbC1leGVjdXRvcnNcXC4oanN8dHMpJC8pO1xuICBhc3NlcnQubWF0Y2gobGF1bmNoPy5lbnY/LkdTRF9XT1JLRkxPV19XUklURV9HQVRFX01PRFVMRSA/PyBcIlwiLCAvd3JpdGUtZ2F0ZVxcLihqc3x0cykkLyk7XG59KTtcblxudGVzdChcImRldGVjdFdvcmtmbG93TWNwTGF1bmNoQ29uZmlnIHJlc29sdmVzIHRoZSBidW5kbGVkIHNlcnZlciByZWxhdGl2ZSB0byB0aGUgaW5zdGFsbGVkIEdTRCBwYWNrYWdlXCIsICgpID0+IHtcbiAgY29uc3QgbGF1bmNoID0gZGV0ZWN0V29ya2Zsb3dNY3BMYXVuY2hDb25maWcoXCIvdG1wL3Byb2plY3RcIiwge1xuICAgIEdTRF9CSU5fUEFUSDogXCIvdG1wL2dzZC1sb2FkZXIuanNcIixcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKGxhdW5jaD8uY29tbWFuZCwgcHJvY2Vzcy5leGVjUGF0aCk7XG4gIGFzc2VydC5lcXVhbChsYXVuY2g/LmN3ZCwgXCIvdG1wL3Byb2plY3RcIik7XG4gIGFzc2VydC5lcXVhbChsYXVuY2g/LmVudj8uR1NEX0NMSV9QQVRILCBcIi90bXAvZ3NkLWxvYWRlci5qc1wiKTtcbiAgYXNzZXJ0LmVxdWFsKGxhdW5jaD8uZW52Py5HU0RfQklOX1BBVEgsIFwiL3RtcC9nc2QtbG9hZGVyLmpzXCIpO1xuICBhc3NlcnQuZXF1YWwobGF1bmNoPy5lbnY/LkdTRF9XT1JLRkxPV19QUk9KRUNUX1JPT1QsIFwiL3RtcC9wcm9qZWN0XCIpO1xuICBhc3NlcnQubWF0Y2gobGF1bmNoPy5lbnY/LkdTRF9XT1JLRkxPV19FWEVDVVRPUlNfTU9EVUxFID8/IFwiXCIsIC93b3JrZmxvdy10b29sLWV4ZWN1dG9yc1xcLihqc3x0cykkLyk7XG4gIGFzc2VydC5tYXRjaChsYXVuY2g/LmVudj8uR1NEX1dPUktGTE9XX1dSSVRFX0dBVEVfTU9EVUxFID8/IFwiXCIsIC93cml0ZS1nYXRlXFwuKGpzfHRzKSQvKTtcbiAgYXNzZXJ0LmVxdWFsKHR5cGVvZiBsYXVuY2g/LmFyZ3M/LlswXSwgXCJzdHJpbmdcIik7XG4gIGFzc2VydC5tYXRjaChsYXVuY2g/LmFyZ3M/LlswXSA/PyBcIlwiLCAvcGFja2FnZXNbXFwvXFxcXF1tY3Atc2VydmVyW1xcL1xcXFxdKGRpc3RbXFwvXFxcXF1jbGlcXC5qc3xzcmNbXFwvXFxcXF1jbGlcXC50cykkLyk7XG4gIGlmICgobGF1bmNoPy5hcmdzPy5bMF0gPz8gXCJcIikuZW5kc1dpdGgoXCIudHNcIikpIHtcbiAgICBhc3NlcnQubWF0Y2gobGF1bmNoPy5lbnY/Lk5PREVfT1BUSU9OUyA/PyBcIlwiLCAvLS1leHBlcmltZW50YWwtc3RyaXAtdHlwZXMvKTtcbiAgICBhc3NlcnQubWF0Y2gobGF1bmNoPy5lbnY/Lk5PREVfT1BUSU9OUyA/PyBcIlwiLCAvcmVzb2x2ZS10c1xcLm1qcy8pO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFdvcmtmbG93TWNwTGF1bmNoQ29uZmlnIHJlc29sdmVzIHRoZSBidW5kbGVkIHNlcnZlciByZWxhdGl2ZSB0byB0aGUgcGFja2FnZSB3aXRob3V0IGVudiBoaW50c1wiLCAoKSA9PiB7XG4gIGNvbnN0IGxhdW5jaCA9IGRldGVjdFdvcmtmbG93TWNwTGF1bmNoQ29uZmlnKFwiL3RtcC9wcm9qZWN0XCIsIHt9KTtcblxuICBhc3NlcnQuZXF1YWwobGF1bmNoPy5jb21tYW5kLCBwcm9jZXNzLmV4ZWNQYXRoKTtcbiAgYXNzZXJ0LmVxdWFsKGxhdW5jaD8uY3dkLCBcIi90bXAvcHJvamVjdFwiKTtcbiAgYXNzZXJ0LmVxdWFsKGxhdW5jaD8uZW52Py5HU0RfQ0xJX1BBVEgsIHVuZGVmaW5lZCk7XG4gIGFzc2VydC5lcXVhbChsYXVuY2g/LmVudj8uR1NEX0JJTl9QQVRILCB1bmRlZmluZWQpO1xuICBhc3NlcnQuZXF1YWwobGF1bmNoPy5lbnY/LkdTRF9XT1JLRkxPV19QUk9KRUNUX1JPT1QsIFwiL3RtcC9wcm9qZWN0XCIpO1xuICBhc3NlcnQubWF0Y2gobGF1bmNoPy5lbnY/LkdTRF9XT1JLRkxPV19FWEVDVVRPUlNfTU9EVUxFID8/IFwiXCIsIC93b3JrZmxvdy10b29sLWV4ZWN1dG9yc1xcLihqc3x0cykkLyk7XG4gIGFzc2VydC5tYXRjaChsYXVuY2g/LmVudj8uR1NEX1dPUktGTE9XX1dSSVRFX0dBVEVfTU9EVUxFID8/IFwiXCIsIC93cml0ZS1nYXRlXFwuKGpzfHRzKSQvKTtcbiAgYXNzZXJ0LmVxdWFsKHR5cGVvZiBsYXVuY2g/LmFyZ3M/LlswXSwgXCJzdHJpbmdcIik7XG4gIGFzc2VydC5tYXRjaChsYXVuY2g/LmFyZ3M/LlswXSA/PyBcIlwiLCAvcGFja2FnZXNbXFwvXFxcXF1tY3Atc2VydmVyW1xcL1xcXFxdKGRpc3RbXFwvXFxcXF1jbGlcXC5qc3xzcmNbXFwvXFxcXF1jbGlcXC50cykkLyk7XG4gIGlmICgobGF1bmNoPy5hcmdzPy5bMF0gPz8gXCJcIikuZW5kc1dpdGgoXCIudHNcIikpIHtcbiAgICBhc3NlcnQubWF0Y2gobGF1bmNoPy5lbnY/Lk5PREVfT1BUSU9OUyA/PyBcIlwiLCAvLS1leHBlcmltZW50YWwtc3RyaXAtdHlwZXMvKTtcbiAgICBhc3NlcnQubWF0Y2gobGF1bmNoPy5lbnY/Lk5PREVfT1BUSU9OUyA/PyBcIlwiLCAvcmVzb2x2ZS10c1xcLm1qcy8pO1xuICB9XG59KTtcblxudGVzdChcIndvcmtmbG93IE1DUCBsYXVuY2ggY29uZmlnIHJlYWNoZXMgbXV0YXRpb24gdG9vbHMgb3ZlciBzdGRpb1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHByb2plY3RSb290ID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtd29ya2Zsb3ctdHJhbnNwb3J0LVwiKSk7XG4gIG1rZGlyU3luYyhqb2luKHByb2plY3RSb290LCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAvLyBJc29sYXRlIHRoZSBzcGF3bmVkIE1DUCBzZXJ2ZXIgZnJvbSB0aGUgZGV2ZWxvcGVyJ3MgcmVhbCB+Ly5nc2Qgc28gaXRcbiAgLy8gY2FuJ3QgcGljayB1cCBhIGNvbmZpZ3VyZWQgRGlzY29yZC9TbGFjay9UZWxlZ3JhbSBjaGFubmVsIGZyb20gZ2xvYmFsXG4gIC8vIFBSRUZFUkVOQ0VTLm1kIGFuZCByb3V0ZSBhc2tfdXNlcl9xdWVzdGlvbnMgdGhyb3VnaCBhIHJlbW90ZSBhZGFwdGVyXG4gIC8vIGluc3RlYWQgb2YgTUNQIGVsaWNpdGF0aW9uLlxuICBjb25zdCBpc29sYXRlZEdzZEhvbWUgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC13b3JrZmxvdy1ob21lLVwiKSk7XG5cbiAgY29uc3QgbGF1bmNoID0gZGV0ZWN0V29ya2Zsb3dNY3BMYXVuY2hDb25maWcocHJvamVjdFJvb3QsIHt9KTtcbiAgYXNzZXJ0Lm9rKGxhdW5jaCwgXCJleHBlY3RlZCBhIHdvcmtmbG93IE1DUCBsYXVuY2ggY29uZmlnXCIpO1xuICBhc3NlcnQubWF0Y2goXG4gICAgbGF1bmNoLmVudj8uR1NEX1dPUktGTE9XX0VYRUNVVE9SU19NT0RVTEUgPz8gXCJcIixcbiAgICAvKGRpc3RbXFwvXFxcXF1yZXNvdXJjZXNbXFwvXFxcXF1leHRlbnNpb25zW1xcL1xcXFxdZ3NkW1xcL1xcXFxddG9vbHNbXFwvXFxcXF13b3JrZmxvdy10b29sLWV4ZWN1dG9yc1xcLmpzfHNyY1tcXC9cXFxcXXJlc291cmNlc1tcXC9cXFxcXWV4dGVuc2lvbnNbXFwvXFxcXF1nc2RbXFwvXFxcXF10b29sc1tcXC9cXFxcXXdvcmtmbG93LXRvb2wtZXhlY3V0b3JzXFwuKGpzfHRzKSkkLyxcbiAgKTtcbiAgYXNzZXJ0Lm1hdGNoKFxuICAgIGxhdW5jaC5lbnY/LkdTRF9XT1JLRkxPV19XUklURV9HQVRFX01PRFVMRSA/PyBcIlwiLFxuICAgIC8oZGlzdFtcXC9cXFxcXXJlc291cmNlc1tcXC9cXFxcXWV4dGVuc2lvbnNbXFwvXFxcXF1nc2RbXFwvXFxcXF1ib290c3RyYXBbXFwvXFxcXF13cml0ZS1nYXRlXFwuanN8c3JjW1xcL1xcXFxdcmVzb3VyY2VzW1xcL1xcXFxdZXh0ZW5zaW9uc1tcXC9cXFxcXWdzZFtcXC9cXFxcXWJvb3RzdHJhcFtcXC9cXFxcXXdyaXRlLWdhdGVcXC4oanN8dHMpKSQvLFxuICApO1xuICBpZiAoKGxhdW5jaC5lbnY/LkdTRF9XT1JLRkxPV19FWEVDVVRPUlNfTU9EVUxFID8/IFwiXCIpLmVuZHNXaXRoKFwiLnRzXCIpKSB7XG4gICAgYXNzZXJ0Lm1hdGNoKGxhdW5jaC5lbnY/Lk5PREVfT1BUSU9OUyA/PyBcIlwiLCAvLS1leHBlcmltZW50YWwtc3RyaXAtdHlwZXMvKTtcbiAgICBhc3NlcnQubWF0Y2gobGF1bmNoLmVudj8uTk9ERV9PUFRJT05TID8/IFwiXCIsIC9yZXNvbHZlLXRzXFwubWpzLyk7XG4gIH1cblxuICBjb25zdCBjbGllbnQgPSBuZXcgQ2xpZW50KFxuICAgIHsgbmFtZTogXCJ3b3JrZmxvdy1tY3AtdHJhbnNwb3J0LXRlc3RcIiwgdmVyc2lvbjogXCIxLjAuMFwiIH0sXG4gICAgeyBjYXBhYmlsaXRpZXM6IHsgZWxpY2l0YXRpb246IHt9IH0gfSxcbiAgKTtcbiAgY2xpZW50LnNldFJlcXVlc3RIYW5kbGVyKEVsaWNpdFJlcXVlc3RTY2hlbWEsIGFzeW5jIChyZXF1ZXN0KSA9PiB7XG4gICAgY29uc3QgZWxpY2l0YXRpb24gPSBleHRyYWN0RWxpY2l0UGF5bG9hZChyZXF1ZXN0IGFzIHVua25vd24pO1xuXG4gICAgYXNzZXJ0Lm1hdGNoKGVsaWNpdGF0aW9uLm1lc3NhZ2UsIC9QbGVhc2UgYW5zd2VyIHRoZSBmb2xsb3dpbmcgcXVlc3Rpb24vKTtcbiAgICBhc3NlcnQub2soZWxpY2l0YXRpb24ucmVxdWVzdGVkU2NoZW1hLnByb3BlcnRpZXMudHJhbnNwb3J0X21vZGUpO1xuICAgIGFzc2VydC5vayhlbGljaXRhdGlvbi5yZXF1ZXN0ZWRTY2hlbWEucHJvcGVydGllc1tcInRyYW5zcG9ydF9tb2RlX19ub3RlXCJdKTtcbiAgICBhc3NlcnQub2soZWxpY2l0YXRpb24ucmVxdWVzdGVkU2NoZW1hLnJlcXVpcmVkPy5pbmNsdWRlcyhcInRyYW5zcG9ydF9tb2RlXCIpKTtcblxuICAgIHJldHVybiB7XG4gICAgICBhY3Rpb246IFwiYWNjZXB0XCIsXG4gICAgICBjb250ZW50OiB7XG4gICAgICAgIHRyYW5zcG9ydF9tb2RlOiBcIk5vbmUgb2YgdGhlIGFib3ZlXCIsXG4gICAgICAgIHRyYW5zcG9ydF9tb2RlX19ub3RlOiBcIk5lZWQgV2luZG93cy1zYWZlIE1DUCBlbGljaXRhdGlvbi5cIixcbiAgICAgIH0sXG4gICAgfTtcbiAgfSk7XG4gIGNvbnN0IHRyYW5zcG9ydCA9IG5ldyBTdGRpb0NsaWVudFRyYW5zcG9ydCh7XG4gICAgY29tbWFuZDogbGF1bmNoLmNvbW1hbmQsXG4gICAgYXJnczogbGF1bmNoLmFyZ3MsXG4gICAgZW52OiB7XG4gICAgICAuLi5wcm9jZXNzLmVudixcbiAgICAgIC4uLmxhdW5jaC5lbnYsXG4gICAgICBHU0RfSE9NRTogaXNvbGF0ZWRHc2RIb21lLFxuICAgICAgRElTQ09SRF9CT1RfVE9LRU46IFwiXCIsXG4gICAgICBTTEFDS19CT1RfVE9LRU46IFwiXCIsXG4gICAgICBURUxFR1JBTV9CT1RfVE9LRU46IFwiXCIsXG4gICAgfSBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxuICAgIGN3ZDogbGF1bmNoLmN3ZCxcbiAgICBzdGRlcnI6IFwicGlwZVwiLFxuICB9KTtcblxuICB0cnkge1xuICAgIGF3YWl0IGNsaWVudC5jb25uZWN0KHRyYW5zcG9ydCwgeyB0aW1lb3V0OiAzMF8wMDAgfSk7XG5cbiAgICBjb25zdCB0b29scyA9IGF3YWl0IGNsaWVudC5saXN0VG9vbHModW5kZWZpbmVkLCB7IHRpbWVvdXQ6IDMwXzAwMCB9KTtcbiAgICBhc3NlcnQub2soXG4gICAgICAodG9vbHMudG9vbHMgPz8gW10pLnNvbWUoKHRvb2wpID0+IHRvb2wubmFtZSA9PT0gXCJnc2RfcGxhbl9zbGljZVwiKSxcbiAgICAgIFwiZXhwZWN0ZWQgd29ya2Zsb3cgTUNQIHN1cmZhY2UgdG8gZXhwb3NlIGdzZF9wbGFuX3NsaWNlXCIsXG4gICAgKTtcbiAgICBhc3NlcnQub2soXG4gICAgICAodG9vbHMudG9vbHMgPz8gW10pLnNvbWUoKHRvb2wpID0+IHRvb2wubmFtZSA9PT0gXCJhc2tfdXNlcl9xdWVzdGlvbnNcIiksXG4gICAgICBcImV4cGVjdGVkIHdvcmtmbG93IE1DUCBzdXJmYWNlIHRvIGV4cG9zZSBhc2tfdXNlcl9xdWVzdGlvbnNcIixcbiAgICApO1xuXG4gICAgY29uc3QgYXNrUmVzdWx0ID0gYXdhaXQgY2xpZW50LmNhbGxUb29sKFxuICAgICAge1xuICAgICAgICBuYW1lOiBcImFza191c2VyX3F1ZXN0aW9uc1wiLFxuICAgICAgICBhcmd1bWVudHM6IHtcbiAgICAgICAgICBxdWVzdGlvbnM6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgaWQ6IFwidHJhbnNwb3J0X21vZGVcIixcbiAgICAgICAgICAgICAgaGVhZGVyOiBcIlRyYW5zcG9ydFwiLFxuICAgICAgICAgICAgICBxdWVzdGlvbjogXCJIb3cgc2hvdWxkIHRoZSB3b3JrZmxvdyBwcm9tcHQgYmUgZGVsaXZlcmVkP1wiLFxuICAgICAgICAgICAgICBvcHRpb25zOiBbXG4gICAgICAgICAgICAgICAgeyBsYWJlbDogXCJMb2NhbCBVSVwiLCBkZXNjcmlwdGlvbjogXCJVc2UgdGhlIGhvc3QgdG9vbCBVSS5cIiB9LFxuICAgICAgICAgICAgICAgIHsgbGFiZWw6IFwiUmVtb3RlIFVJXCIsIGRlc2NyaXB0aW9uOiBcIlVzZSBhIHJlbW90ZSByZXNwb25zZSBjaGFubmVsLlwiIH0sXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgdW5kZWZpbmVkLFxuICAgICAgeyB0aW1lb3V0OiAzMF8wMDAgfSxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChhc2tSZXN1bHQuaXNFcnJvciwgdW5kZWZpbmVkKTtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICAoKGFza1Jlc3VsdC5jb250ZW50IGFzIEFycmF5PHsgdGV4dD86IHN0cmluZyB9Pik/LlswXSk/LnRleHQgPz8gXCJcIixcbiAgICAgIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgYW5zd2Vyczoge1xuICAgICAgICAgIHRyYW5zcG9ydF9tb2RlOiB7XG4gICAgICAgICAgICBhbnN3ZXJzOiBbXCJOb25lIG9mIHRoZSBhYm92ZVwiLCBcInVzZXJfbm90ZTogTmVlZCBXaW5kb3dzLXNhZmUgTUNQIGVsaWNpdGF0aW9uLlwiXSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIGNvbnN0IG1pbGVzdG9uZVJlc3VsdCA9IGF3YWl0IGNsaWVudC5jYWxsVG9vbChcbiAgICAgIHtcbiAgICAgICAgbmFtZTogXCJnc2RfcGxhbl9taWxlc3RvbmVcIixcbiAgICAgICAgYXJndW1lbnRzOiB7XG4gICAgICAgICAgcHJvamVjdERpcjogcHJvamVjdFJvb3QsXG4gICAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICAgIHRpdGxlOiBcIlRyYW5zcG9ydCBwbGFubmluZ1wiLFxuICAgICAgICAgIHZpc2lvbjogXCJWZXJpZnkgc3RkaW8gd29ya2Zsb3cgTUNQIHVzZXMgdGhlIGV4ZWN1dG9yIGJyaWRnZS5cIixcbiAgICAgICAgICBzbGljZXM6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgc2xpY2VJZDogXCJTMDFcIixcbiAgICAgICAgICAgICAgdGl0bGU6IFwiQnJpZGdlIHBhdGhcIixcbiAgICAgICAgICAgICAgcmlzazogXCJsb3dcIixcbiAgICAgICAgICAgICAgZGVwZW5kczogW10sXG4gICAgICAgICAgICAgIGRlbW86IFwiTWlsZXN0b25lIHBsYW5uaW5nIHN1Y2NlZWRzIG92ZXIgc3RkaW8gTUNQLlwiLFxuICAgICAgICAgICAgICBnb2FsOiBcIlByb3ZlIHRoZSBleGVjdXRvciBicmlkZ2Ugd29ya3MgaW4gdGhlIHNwYXduZWQgc2VydmVyLlwiLFxuICAgICAgICAgICAgICBzdWNjZXNzQ3JpdGVyaWE6IFwiZ3NkX3BsYW5fc2xpY2UgY2FuIHdyaXRlIHBsYW4gYXJ0aWZhY3RzLlwiLFxuICAgICAgICAgICAgICBwcm9vZkxldmVsOiBcImludGVncmF0aW9uXCIsXG4gICAgICAgICAgICAgIGludGVncmF0aW9uQ2xvc3VyZTogXCJTdGRpbyBNQ1AgY2xpZW50IHJlYWNoZXMgdGhlIHdvcmtmbG93IGV4ZWN1dG9yIGJyaWRnZS5cIixcbiAgICAgICAgICAgICAgb2JzZXJ2YWJpbGl0eUltcGFjdDogXCJSZWdyZXNzaW9uIHRlc3QgY292ZXJzIHRoZSBzcGF3bmVkLXNlcnZlciBwYXRoLlwiLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHVuZGVmaW5lZCxcbiAgICAgIHsgdGltZW91dDogMzBfMDAwIH0sXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwobWlsZXN0b25lUmVzdWx0LmlzRXJyb3IsIHVuZGVmaW5lZCk7XG4gICAgYXNzZXJ0Lm1hdGNoKFxuICAgICAgKChtaWxlc3RvbmVSZXN1bHQuY29udGVudCBhcyBBcnJheTx7IHRleHQ/OiBzdHJpbmcgfT4pPy5bMF0pPy50ZXh0ID8/IFwiXCIsXG4gICAgICAvUGxhbm5lZCBtaWxlc3RvbmUgTTAwMS8sXG4gICAgKTtcblxuICAgIGNvbnN0IHNsaWNlUmVzdWx0ID0gYXdhaXQgY2xpZW50LmNhbGxUb29sKFxuICAgICAge1xuICAgICAgICBuYW1lOiBcImdzZF9wbGFuX3NsaWNlXCIsXG4gICAgICAgIGFyZ3VtZW50czoge1xuICAgICAgICAgIHByb2plY3REaXI6IHByb2plY3RSb290LFxuICAgICAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgICAgICBzbGljZUlkOiBcIlMwMVwiLFxuICAgICAgICAgIGdvYWw6IFwiUGVyc2lzdCBzbGljZSBwbGFubmluZyBvdmVyIHRoZSBzcGF3bmVkIE1DUCB0cmFuc3BvcnQuXCIsXG4gICAgICAgICAgdGFza3M6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgdGFza0lkOiBcIlQwMVwiLFxuICAgICAgICAgICAgICB0aXRsZTogXCJDb25uZWN0IHRoZSBicmlkZ2VcIixcbiAgICAgICAgICAgICAgZGVzY3JpcHRpb246IFwiRW5zdXJlIHRoZSB3b3JrZmxvdyBleGVjdXRvciBicmlkZ2UgcmVzb2x2ZXMgaW4gdGhlIGNoaWxkIHByb2Nlc3MuXCIsXG4gICAgICAgICAgICAgIGVzdGltYXRlOiBcIjEwbVwiLFxuICAgICAgICAgICAgICBmaWxlczogW1wic3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC93b3JrZmxvdy1tY3AudHNcIl0sXG4gICAgICAgICAgICAgIHZlcmlmeTogXCJub2RlIC0tdGVzdFwiLFxuICAgICAgICAgICAgICBpbnB1dHM6IFtcIi5nc2QvbWlsZXN0b25lcy9NMDAxL00wMDEtUk9BRE1BUC5tZFwiXSxcbiAgICAgICAgICAgICAgZXhwZWN0ZWRPdXRwdXQ6IFtcIlMwMS1QTEFOLm1kXCIsIFwiVDAxLVBMQU4ubWRcIl0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgdW5kZWZpbmVkLFxuICAgICAgeyB0aW1lb3V0OiAzMF8wMDAgfSxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChzbGljZVJlc3VsdC5pc0Vycm9yLCB1bmRlZmluZWQpO1xuICAgIGFzc2VydC5tYXRjaChcbiAgICAgICgoc2xpY2VSZXN1bHQuY29udGVudCBhcyBBcnJheTx7IHRleHQ/OiBzdHJpbmcgfT4pPy5bMF0pPy50ZXh0ID8/IFwiXCIsXG4gICAgICAvUGxhbm5lZCBzbGljZSBTMDEvLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgZXhpc3RzU3luYyhqb2luKHByb2plY3RSb290LCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiLCBcIlMwMS1QTEFOLm1kXCIpKSxcbiAgICAgIFwiZXhwZWN0ZWQgc2xpY2UgcGxhbiBhcnRpZmFjdCB0byBiZSB3cml0dGVuIHRocm91Z2ggc3RkaW8gTUNQXCIsXG4gICAgKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBleGlzdHNTeW5jKFxuICAgICAgICBqb2luKHByb2plY3RSb290LCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiLCBcInRhc2tzXCIsIFwiVDAxLVBMQU4ubWRcIiksXG4gICAgICApLFxuICAgICAgXCJleHBlY3RlZCB0YXNrIHBsYW4gYXJ0aWZhY3QgdG8gYmUgd3JpdHRlbiB0aHJvdWdoIHN0ZGlvIE1DUFwiLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgY2xpZW50LmNsb3NlKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIHJtU3luYyhwcm9qZWN0Um9vdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIHJtU3luYyhpc29sYXRlZEdzZEhvbWUsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJ3b3JrZmxvdyBNQ1AgYXNrX3VzZXJfcXVlc3Rpb25zIHVzZXMgc3RkaW8gZWxpY2l0YXRpb24gcm91bmQtdHJpcFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHByb2plY3RSb290ID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtd29ya2Zsb3ctZWxpY2l0LVwiKSk7XG4gIG1rZGlyU3luYyhqb2luKHByb2plY3RSb290LCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBjb25zdCBpc29sYXRlZEdzZEhvbWUgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC13b3JrZmxvdy1ob21lLVwiKSk7XG5cbiAgY29uc3QgbGF1bmNoID0gZGV0ZWN0V29ya2Zsb3dNY3BMYXVuY2hDb25maWcocHJvamVjdFJvb3QsIHt9KTtcbiAgYXNzZXJ0Lm9rKGxhdW5jaCwgXCJleHBlY3RlZCBhIHdvcmtmbG93IE1DUCBsYXVuY2ggY29uZmlnXCIpO1xuXG4gIGNvbnN0IGNsaWVudCA9IG5ldyBDbGllbnQoXG4gICAgeyBuYW1lOiBcIndvcmtmbG93LW1jcC1lbGljaXQtdGVzdFwiLCB2ZXJzaW9uOiBcIjEuMC4wXCIgfSxcbiAgICB7IGNhcGFiaWxpdGllczogeyBlbGljaXRhdGlvbjoge30gfSB9LFxuICApO1xuICBsZXQgcmVxdWVzdFNlZW46IHtcbiAgICBtZXNzYWdlOiBzdHJpbmc7XG4gICAgcmVxdWVzdGVkU2NoZW1hOiB7IHByb3BlcnRpZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+OyByZXF1aXJlZD86IHN0cmluZ1tdIH07XG4gIH0gfCBudWxsID0gbnVsbDtcblxuICBjbGllbnQuc2V0UmVxdWVzdEhhbmRsZXIoRWxpY2l0UmVxdWVzdFNjaGVtYSwgYXN5bmMgKHJlcXVlc3QpID0+IHtcbiAgICBjb25zdCBwYXJhbXMgPSBleHRyYWN0RWxpY2l0UGF5bG9hZChyZXF1ZXN0IGFzIHVua25vd24pO1xuXG4gICAgcmVxdWVzdFNlZW4gPSBwYXJhbXM7XG5cbiAgICByZXR1cm4ge1xuICAgICAgYWN0aW9uOiBcImFjY2VwdFwiLFxuICAgICAgY29udGVudDoge1xuICAgICAgICBkZXBsb3ltZW50OiBcIk5vbmUgb2YgdGhlIGFib3ZlXCIsXG4gICAgICAgIGRlcGxveW1lbnRfX25vdGU6IFwiTmVlZCBoeWJyaWQgZGVwbG95bWVudC5cIixcbiAgICAgIH0sXG4gICAgfTtcbiAgfSk7XG5cbiAgY29uc3QgdHJhbnNwb3J0ID0gbmV3IFN0ZGlvQ2xpZW50VHJhbnNwb3J0KHtcbiAgICBjb21tYW5kOiBsYXVuY2guY29tbWFuZCxcbiAgICBhcmdzOiBsYXVuY2guYXJncyxcbiAgICBlbnY6IHtcbiAgICAgIC4uLnByb2Nlc3MuZW52LFxuICAgICAgLi4ubGF1bmNoLmVudixcbiAgICAgIEdTRF9IT01FOiBpc29sYXRlZEdzZEhvbWUsXG4gICAgICBESVNDT1JEX0JPVF9UT0tFTjogXCJcIixcbiAgICAgIFNMQUNLX0JPVF9UT0tFTjogXCJcIixcbiAgICAgIFRFTEVHUkFNX0JPVF9UT0tFTjogXCJcIixcbiAgICB9IGFzIFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXG4gICAgY3dkOiBsYXVuY2guY3dkLFxuICAgIHN0ZGVycjogXCJwaXBlXCIsXG4gIH0pO1xuXG4gIHRyeSB7XG4gICAgYXdhaXQgY2xpZW50LmNvbm5lY3QodHJhbnNwb3J0LCB7IHRpbWVvdXQ6IDMwXzAwMCB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNsaWVudC5jYWxsVG9vbChcbiAgICAgIHtcbiAgICAgICAgbmFtZTogXCJhc2tfdXNlcl9xdWVzdGlvbnNcIixcbiAgICAgICAgYXJndW1lbnRzOiB7XG4gICAgICAgICAgcXVlc3Rpb25zOiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIGlkOiBcImRlcGxveW1lbnRcIixcbiAgICAgICAgICAgICAgaGVhZGVyOiBcIkRlcGxveVwiLFxuICAgICAgICAgICAgICBxdWVzdGlvbjogXCJXaGVyZSB3aWxsIHRoaXMgcnVuP1wiLFxuICAgICAgICAgICAgICBvcHRpb25zOiBbXG4gICAgICAgICAgICAgICAgeyBsYWJlbDogXCJDbG91ZFwiLCBkZXNjcmlwdGlvbjogXCJNYW5hZ2VkIGhvc3RpbmcuXCIgfSxcbiAgICAgICAgICAgICAgICB7IGxhYmVsOiBcIk9uLXByZW1cIiwgZGVzY3JpcHRpb246IFwiUnVucyBpbiBjdXN0b21lciBpbmZyYXN0cnVjdHVyZS5cIiB9LFxuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHVuZGVmaW5lZCxcbiAgICAgIHsgdGltZW91dDogMzBfMDAwIH0sXG4gICAgKTtcblxuICAgIGFzc2VydC5vayhyZXF1ZXN0U2VlbiwgXCJleHBlY3RlZCBzdGRpbyB0cmFuc3BvcnQgdG8gZm9yd2FyZCBhbiBlbGljaXRhdGlvbiByZXF1ZXN0XCIpO1xuICAgIGNvbnN0IHNlZW4gPSByZXF1ZXN0U2VlbiBhcyBFbGljaXRQYXlsb2FkO1xuICAgIGFzc2VydC5tYXRjaChzZWVuLm1lc3NhZ2UsIC9QbGVhc2UgYW5zd2VyIHRoZSBmb2xsb3dpbmcgcXVlc3Rpb24vKTtcbiAgICBhc3NlcnQub2soc2Vlbi5yZXF1ZXN0ZWRTY2hlbWEucHJvcGVydGllcy5kZXBsb3ltZW50KTtcbiAgICBhc3NlcnQub2soc2Vlbi5yZXF1ZXN0ZWRTY2hlbWEucHJvcGVydGllcy5kZXBsb3ltZW50X19ub3RlKTtcbiAgICBhc3NlcnQub2soc2Vlbi5yZXF1ZXN0ZWRTY2hlbWEucmVxdWlyZWQ/LmluY2x1ZGVzKFwiZGVwbG95bWVudFwiKSk7XG5cbiAgICBjb25zdCBjb250ZW50ID0gKHJlc3VsdCBhcyB7IGNvbnRlbnQ6IEFycmF5PHsgdHlwZTogc3RyaW5nOyB0ZXh0Pzogc3RyaW5nIH0+IH0pLmNvbnRlbnQ7XG4gICAgY29uc3QgdGV4dCA9IGNvbnRlbnQuZmluZCgoaXRlbTogeyB0eXBlOiBzdHJpbmc7IHRleHQ/OiBzdHJpbmcgfSkgPT4gaXRlbS50eXBlID09PSBcInRleHRcIik7XG4gICAgYXNzZXJ0Lm9rKHRleHQgJiYgXCJ0ZXh0XCIgaW4gdGV4dCk7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgdGV4dC50ZXh0LFxuICAgICAgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBhbnN3ZXJzOiB7XG4gICAgICAgICAgZGVwbG95bWVudDoge1xuICAgICAgICAgICAgYW5zd2VyczogW1wiTm9uZSBvZiB0aGUgYWJvdmVcIiwgXCJ1c2VyX25vdGU6IE5lZWQgaHlicmlkIGRlcGxveW1lbnQuXCJdLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IGNsaWVudC5jbG9zZSgpO1xuICAgIHJtU3luYyhwcm9qZWN0Um9vdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIHJtU3luYyhpc29sYXRlZEdzZEhvbWUsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJ1c2VzV29ya2Zsb3dNY3BUcmFuc3BvcnQgbWF0Y2hlcyBsb2NhbCBleHRlcm5hbENsaSBwcm92aWRlcnNcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwodXNlc1dvcmtmbG93TWNwVHJhbnNwb3J0KFwiZXh0ZXJuYWxDbGlcIiwgXCJsb2NhbDovL2NsYXVkZS1jb2RlXCIpLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKHVzZXNXb3JrZmxvd01jcFRyYW5zcG9ydChcImV4dGVybmFsQ2xpXCIsIFwiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb21cIiksIGZhbHNlKTtcbiAgYXNzZXJ0LmVxdWFsKHVzZXNXb3JrZmxvd01jcFRyYW5zcG9ydChcIm9hdXRoXCIsIFwibG9jYWw6Ly9jdXN0b21cIiksIGZhbHNlKTtcbn0pO1xuXG50ZXN0KFwic3VwcG9ydHNTdHJ1Y3R1cmVkUXVlc3Rpb25zIGRpc2FibGVzIGxvY2FsIHdvcmtmbG93IE1DUCBxdWVzdGlvbnMgdW5sZXNzIGV4cGxpY2l0bHkgZW5hYmxlZFwiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChcbiAgICBzdXBwb3J0c1N0cnVjdHVyZWRRdWVzdGlvbnMoW1wiYXNrX3VzZXJfcXVlc3Rpb25zXCJdLCB7XG4gICAgICBhdXRoTW9kZTogXCJleHRlcm5hbENsaVwiLFxuICAgICAgYmFzZVVybDogXCJsb2NhbDovL2NsYXVkZS1jb2RlXCIsXG4gICAgICBlbnY6IHt9LFxuICAgIH0pLFxuICAgIGZhbHNlLFxuICApO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgc3VwcG9ydHNTdHJ1Y3R1cmVkUXVlc3Rpb25zKFtcIm1jcF9fZ3NkLXdvcmtmbG93X19hc2tfdXNlcl9xdWVzdGlvbnNcIl0sIHtcbiAgICAgIGF1dGhNb2RlOiBcImV4dGVybmFsQ2xpXCIsXG4gICAgICBiYXNlVXJsOiBcImxvY2FsOi8vY2xhdWRlLWNvZGVcIixcbiAgICAgIGVudjogeyBHU0RfV09SS0ZMT1dfTUNQX1NUUlVDVFVSRURfUVVFU1RJT05TOiBcIjFcIiB9IGFzIE5vZGVKUy5Qcm9jZXNzRW52LFxuICAgIH0pLFxuICAgIHRydWUsXG4gICk7XG4gIGFzc2VydC5lcXVhbChcbiAgICBzdXBwb3J0c1N0cnVjdHVyZWRRdWVzdGlvbnMoW1wiYXNrX3VzZXJfcXVlc3Rpb25zXCJdLCB7XG4gICAgICBhdXRoTW9kZTogXCJvYXV0aFwiLFxuICAgICAgYmFzZVVybDogXCJodHRwczovL2FwaS5hbnRocm9waWMuY29tXCIsXG4gICAgfSksXG4gICAgdHJ1ZSxcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIHN1cHBvcnRzU3RydWN0dXJlZFF1ZXN0aW9ucyhbXSwge1xuICAgICAgYXV0aE1vZGU6IFwib2F1dGhcIixcbiAgICAgIGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkuYW50aHJvcGljLmNvbVwiLFxuICAgIH0pLFxuICAgIGZhbHNlLFxuICApO1xufSk7XG5cbnRlc3QoXCJ0cmFuc3BvcnQgY29tcGF0aWJpbGl0eSBwYXNzZXMgd2hlbiByZXF1aXJlZCB0b29scyBmaXQgY3VycmVudCBNQ1Agc3VyZmFjZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGVycm9yID0gZ2V0V29ya2Zsb3dUcmFuc3BvcnRTdXBwb3J0RXJyb3IoXG4gICAgXCJjbGF1ZGUtY29kZVwiLFxuICAgIFtcImdzZF90YXNrX2NvbXBsZXRlXCJdLFxuICAgIHtcbiAgICAgIHByb2plY3RSb290OiBcIi90bXAvcHJvamVjdFwiLFxuICAgICAgZW52OiB7IEdTRF9XT1JLRkxPV19NQ1BfQ09NTUFORDogXCJub2RlXCIgfSxcbiAgICAgIHN1cmZhY2U6IFwiZ3VpZGVkIGZsb3dcIixcbiAgICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgYXV0aE1vZGU6IFwiZXh0ZXJuYWxDbGlcIixcbiAgICAgIGJhc2VVcmw6IFwibG9jYWw6Ly9jbGF1ZGUtY29kZVwiLFxuICAgIH0sXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKGVycm9yLCBudWxsKTtcbn0pO1xuXG50ZXN0KFwidHJhbnNwb3J0IGNvbXBhdGliaWxpdHkgZGlzY292ZXJzIHRoZSBidW5kbGVkIE1DUCBzZXJ2ZXIgd2l0aG91dCBlbnYgb3ZlcnJpZGVzXCIsICgpID0+IHtcbiAgY29uc3QgZXJyb3IgPSBnZXRXb3JrZmxvd1RyYW5zcG9ydFN1cHBvcnRFcnJvcihcbiAgICBcImNsYXVkZS1jb2RlXCIsXG4gICAgW1wiZ3NkX3Rhc2tfY29tcGxldGVcIl0sXG4gICAge1xuICAgICAgcHJvamVjdFJvb3Q6IFwiL3RtcC9wcm9qZWN0XCIsXG4gICAgICBlbnY6IHt9LFxuICAgICAgc3VyZmFjZTogXCJhdXRvLW1vZGVcIixcbiAgICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgYXV0aE1vZGU6IFwiZXh0ZXJuYWxDbGlcIixcbiAgICAgIGJhc2VVcmw6IFwibG9jYWw6Ly9jbGF1ZGUtY29kZVwiLFxuICAgIH0sXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKGVycm9yLCBudWxsKTtcbn0pO1xuXG50ZXN0KFwidHJhbnNwb3J0IGNvbXBhdGliaWxpdHkgbm93IGFsbG93cyBhdXRvIGV4ZWN1dGUtdGFzayBvdmVyIHdvcmtmbG93IE1DUCBzdXJmYWNlXCIsICgpID0+IHtcbiAgY29uc3QgZXJyb3IgPSBnZXRXb3JrZmxvd1RyYW5zcG9ydFN1cHBvcnRFcnJvcihcbiAgICBcImNsYXVkZS1jb2RlXCIsXG4gICAgW1wiZ3NkX2NvbXBsZXRlX3Rhc2tcIl0sXG4gICAge1xuICAgICAgcHJvamVjdFJvb3Q6IFwiL3RtcC9wcm9qZWN0XCIsXG4gICAgICBlbnY6IHsgR1NEX1dPUktGTE9XX01DUF9DT01NQU5EOiBcIm5vZGVcIiB9LFxuICAgICAgc3VyZmFjZTogXCJhdXRvLW1vZGVcIixcbiAgICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgYXV0aE1vZGU6IFwiZXh0ZXJuYWxDbGlcIixcbiAgICAgIGJhc2VVcmw6IFwibG9jYWw6Ly9jbGF1ZGUtY29kZVwiLFxuICAgIH0sXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKGVycm9yLCBudWxsKTtcbn0pO1xuXG50ZXN0KFwidHJhbnNwb3J0IGNvbXBhdGliaWxpdHkgaWdub3JlcyBBUEktYmFja2VkIHByb3ZpZGVyc1wiLCAoKSA9PiB7XG4gIGNvbnN0IGVycm9yID0gZ2V0V29ya2Zsb3dUcmFuc3BvcnRTdXBwb3J0RXJyb3IoXG4gICAgXCJvcGVuYWktY29kZXhcIixcbiAgICBbXCJnc2RfcGxhbl9zbGljZVwiXSxcbiAgICB7XG4gICAgICBwcm9qZWN0Um9vdDogXCIvdG1wL3Byb2plY3RcIixcbiAgICAgIGVudjoge30sXG4gICAgICBzdXJmYWNlOiBcImF1dG8tbW9kZVwiLFxuICAgICAgdW5pdFR5cGU6IFwicGxhbi1zbGljZVwiLFxuICAgICAgYXV0aE1vZGU6IFwib2F1dGhcIixcbiAgICAgIGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbVwiLFxuICAgIH0sXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKGVycm9yLCBudWxsKTtcbn0pO1xuXG50ZXN0KFwidHJhbnNwb3J0IGNvbXBhdGliaWxpdHkgbm93IGFsbG93cyBwbGFuLXNsaWNlIG92ZXIgd29ya2Zsb3cgTUNQIHN1cmZhY2VcIiwgKCkgPT4ge1xuICBjb25zdCBlcnJvciA9IGdldFdvcmtmbG93VHJhbnNwb3J0U3VwcG9ydEVycm9yKFxuICAgIFwiY2xhdWRlLWNvZGVcIixcbiAgICBbXCJnc2RfcGxhbl9zbGljZVwiXSxcbiAgICB7XG4gICAgICBwcm9qZWN0Um9vdDogXCIvdG1wL3Byb2plY3RcIixcbiAgICAgIGVudjogeyBHU0RfV09SS0ZMT1dfTUNQX0NPTU1BTkQ6IFwibm9kZVwiIH0sXG4gICAgICBzdXJmYWNlOiBcImF1dG8tbW9kZVwiLFxuICAgICAgdW5pdFR5cGU6IFwicGxhbi1zbGljZVwiLFxuICAgICAgYXV0aE1vZGU6IFwiZXh0ZXJuYWxDbGlcIixcbiAgICAgIGJhc2VVcmw6IFwibG9jYWw6Ly9jbGF1ZGUtY29kZVwiLFxuICAgIH0sXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKGVycm9yLCBudWxsKTtcbn0pO1xuXG50ZXN0KFwidHJhbnNwb3J0IGNvbXBhdGliaWxpdHkgbm93IGFsbG93cyBjb21wbGV0ZS1zbGljZSBvdmVyIHdvcmtmbG93IE1DUCBzdXJmYWNlXCIsICgpID0+IHtcbiAgY29uc3QgZXJyb3IgPSBnZXRXb3JrZmxvd1RyYW5zcG9ydFN1cHBvcnRFcnJvcihcbiAgICBcImNsYXVkZS1jb2RlXCIsXG4gICAgW1wiZ3NkX2NvbXBsZXRlX3NsaWNlXCJdLFxuICAgIHtcbiAgICAgIHByb2plY3RSb290OiBcIi90bXAvcHJvamVjdFwiLFxuICAgICAgZW52OiB7IEdTRF9XT1JLRkxPV19NQ1BfQ09NTUFORDogXCJub2RlXCIgfSxcbiAgICAgIHN1cmZhY2U6IFwiYXV0by1tb2RlXCIsXG4gICAgICB1bml0VHlwZTogXCJjb21wbGV0ZS1zbGljZVwiLFxuICAgICAgYXV0aE1vZGU6IFwiZXh0ZXJuYWxDbGlcIixcbiAgICAgIGJhc2VVcmw6IFwibG9jYWw6Ly9jbGF1ZGUtY29kZVwiLFxuICAgIH0sXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKGVycm9yLCBudWxsKTtcbn0pO1xuXG50ZXN0KFwidHJhbnNwb3J0IGNvbXBhdGliaWxpdHkgbm93IGFsbG93cyByZWFzc2Vzcy1yb2FkbWFwIG92ZXIgd29ya2Zsb3cgTUNQIHN1cmZhY2VcIiwgKCkgPT4ge1xuICBjb25zdCBlcnJvciA9IGdldFdvcmtmbG93VHJhbnNwb3J0U3VwcG9ydEVycm9yKFxuICAgIFwiY2xhdWRlLWNvZGVcIixcbiAgICBbXCJnc2RfbWlsZXN0b25lX3N0YXR1c1wiLCBcImdzZF9yZWFzc2Vzc19yb2FkbWFwXCJdLFxuICAgIHtcbiAgICAgIHByb2plY3RSb290OiBcIi90bXAvcHJvamVjdFwiLFxuICAgICAgZW52OiB7IEdTRF9XT1JLRkxPV19NQ1BfQ09NTUFORDogXCJub2RlXCIgfSxcbiAgICAgIHN1cmZhY2U6IFwiYXV0by1tb2RlXCIsXG4gICAgICB1bml0VHlwZTogXCJyZWFzc2Vzcy1yb2FkbWFwXCIsXG4gICAgICBhdXRoTW9kZTogXCJleHRlcm5hbENsaVwiLFxuICAgICAgYmFzZVVybDogXCJsb2NhbDovL2NsYXVkZS1jb2RlXCIsXG4gICAgfSxcbiAgKTtcblxuICBhc3NlcnQuZXF1YWwoZXJyb3IsIG51bGwpO1xufSk7XG5cbnRlc3QoXCJ0cmFuc3BvcnQgY29tcGF0aWJpbGl0eSBub3cgYWxsb3dzIGdhdGUtZXZhbHVhdGUgb3ZlciB3b3JrZmxvdyBNQ1Agc3VyZmFjZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGVycm9yID0gZ2V0V29ya2Zsb3dUcmFuc3BvcnRTdXBwb3J0RXJyb3IoXG4gICAgXCJjbGF1ZGUtY29kZVwiLFxuICAgIFtcImdzZF9zYXZlX2dhdGVfcmVzdWx0XCJdLFxuICAgIHtcbiAgICAgIHByb2plY3RSb290OiBcIi90bXAvcHJvamVjdFwiLFxuICAgICAgZW52OiB7IEdTRF9XT1JLRkxPV19NQ1BfQ09NTUFORDogXCJub2RlXCIgfSxcbiAgICAgIHN1cmZhY2U6IFwiYXV0by1tb2RlXCIsXG4gICAgICB1bml0VHlwZTogXCJnYXRlLWV2YWx1YXRlXCIsXG4gICAgICBhdXRoTW9kZTogXCJleHRlcm5hbENsaVwiLFxuICAgICAgYmFzZVVybDogXCJsb2NhbDovL2NsYXVkZS1jb2RlXCIsXG4gICAgfSxcbiAgKTtcblxuICBhc3NlcnQuZXF1YWwoZXJyb3IsIG51bGwpO1xufSk7XG5cbnRlc3QoXCJ0cmFuc3BvcnQgY29tcGF0aWJpbGl0eSBub3cgYWxsb3dzIHZhbGlkYXRlLW1pbGVzdG9uZSBvdmVyIHdvcmtmbG93IE1DUCBzdXJmYWNlXCIsICgpID0+IHtcbiAgY29uc3QgZXJyb3IgPSBnZXRXb3JrZmxvd1RyYW5zcG9ydFN1cHBvcnRFcnJvcihcbiAgICBcImNsYXVkZS1jb2RlXCIsXG4gICAgW1wiZ3NkX21pbGVzdG9uZV9zdGF0dXNcIiwgXCJnc2RfdmFsaWRhdGVfbWlsZXN0b25lXCJdLFxuICAgIHtcbiAgICAgIHByb2plY3RSb290OiBcIi90bXAvcHJvamVjdFwiLFxuICAgICAgZW52OiB7IEdTRF9XT1JLRkxPV19NQ1BfQ09NTUFORDogXCJub2RlXCIgfSxcbiAgICAgIHN1cmZhY2U6IFwiYXV0by1tb2RlXCIsXG4gICAgICB1bml0VHlwZTogXCJ2YWxpZGF0ZS1taWxlc3RvbmVcIixcbiAgICAgIGF1dGhNb2RlOiBcImV4dGVybmFsQ2xpXCIsXG4gICAgICBiYXNlVXJsOiBcImxvY2FsOi8vY2xhdWRlLWNvZGVcIixcbiAgICB9LFxuICApO1xuXG4gIGFzc2VydC5lcXVhbChlcnJvciwgbnVsbCk7XG59KTtcblxudGVzdChcInRyYW5zcG9ydCBjb21wYXRpYmlsaXR5IG5vdyBhbGxvd3MgY29tcGxldGUtbWlsZXN0b25lIG92ZXIgd29ya2Zsb3cgTUNQIHN1cmZhY2VcIiwgKCkgPT4ge1xuICBjb25zdCBlcnJvciA9IGdldFdvcmtmbG93VHJhbnNwb3J0U3VwcG9ydEVycm9yKFxuICAgIFwiY2xhdWRlLWNvZGVcIixcbiAgICBbXCJnc2RfbWlsZXN0b25lX3N0YXR1c1wiLCBcImdzZF9jb21wbGV0ZV9taWxlc3RvbmVcIl0sXG4gICAge1xuICAgICAgcHJvamVjdFJvb3Q6IFwiL3RtcC9wcm9qZWN0XCIsXG4gICAgICBlbnY6IHsgR1NEX1dPUktGTE9XX01DUF9DT01NQU5EOiBcIm5vZGVcIiB9LFxuICAgICAgc3VyZmFjZTogXCJhdXRvLW1vZGVcIixcbiAgICAgIHVuaXRUeXBlOiBcImNvbXBsZXRlLW1pbGVzdG9uZVwiLFxuICAgICAgYXV0aE1vZGU6IFwiZXh0ZXJuYWxDbGlcIixcbiAgICAgIGJhc2VVcmw6IFwibG9jYWw6Ly9jbGF1ZGUtY29kZVwiLFxuICAgIH0sXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKGVycm9yLCBudWxsKTtcbn0pO1xuXG50ZXN0KFwidHJhbnNwb3J0IGNvbXBhdGliaWxpdHkgbm93IGFsbG93cyByZXBsYW4tc2xpY2Ugb3ZlciB3b3JrZmxvdyBNQ1Agc3VyZmFjZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGVycm9yID0gZ2V0V29ya2Zsb3dUcmFuc3BvcnRTdXBwb3J0RXJyb3IoXG4gICAgXCJjbGF1ZGUtY29kZVwiLFxuICAgIFtcImdzZF9yZXBsYW5fc2xpY2VcIl0sXG4gICAge1xuICAgICAgcHJvamVjdFJvb3Q6IFwiL3RtcC9wcm9qZWN0XCIsXG4gICAgICBlbnY6IHsgR1NEX1dPUktGTE9XX01DUF9DT01NQU5EOiBcIm5vZGVcIiB9LFxuICAgICAgc3VyZmFjZTogXCJhdXRvLW1vZGVcIixcbiAgICAgIHVuaXRUeXBlOiBcInJlcGxhbi1zbGljZVwiLFxuICAgICAgYXV0aE1vZGU6IFwiZXh0ZXJuYWxDbGlcIixcbiAgICAgIGJhc2VVcmw6IFwibG9jYWw6Ly9jbGF1ZGUtY29kZVwiLFxuICAgIH0sXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKGVycm9yLCBudWxsKTtcbn0pO1xuXG50ZXN0KFwidHJhbnNwb3J0IGNvbXBhdGliaWxpdHkgc3RpbGwgYmxvY2tzIHVuaXRzIHdob3NlIE1DUCB0b29scyBhcmUgbm90IGV4cG9zZWRcIiwgKCkgPT4ge1xuICBjb25zdCBlcnJvciA9IGdldFdvcmtmbG93VHJhbnNwb3J0U3VwcG9ydEVycm9yKFxuICAgIFwiY2xhdWRlLWNvZGVcIixcbiAgICBbXCJzZWN1cmVfZW52X2NvbGxlY3RcIl0sXG4gICAge1xuICAgICAgcHJvamVjdFJvb3Q6IFwiL3RtcC9wcm9qZWN0XCIsXG4gICAgICBlbnY6IHsgR1NEX1dPUktGTE9XX01DUF9DT01NQU5EOiBcIm5vZGVcIiB9LFxuICAgICAgc3VyZmFjZTogXCJhdXRvLW1vZGVcIixcbiAgICAgIHVuaXRUeXBlOiBcImd1aWRlZC1kaXNjdXNzaW9uXCIsXG4gICAgICBhdXRoTW9kZTogXCJleHRlcm5hbENsaVwiLFxuICAgICAgYmFzZVVybDogXCJsb2NhbDovL2NsYXVkZS1jb2RlXCIsXG4gICAgfSxcbiAgKTtcblxuICBhc3NlcnQubWF0Y2goZXJyb3IgPz8gXCJcIiwgL3JlcXVpcmVzIHNlY3VyZV9lbnZfY29sbGVjdC8pO1xuICBhc3NlcnQubWF0Y2goZXJyb3IgPz8gXCJcIiwgL2N1cnJlbnRseSBleHBvc2VzIG9ubHkvKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLFlBQVksYUFBYSxXQUFXLFFBQVEscUJBQXFCO0FBQzFFLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsNEJBQTRCO0FBQ3JDLFNBQVMsMkJBQTJCO0FBRXBDO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFPUCxTQUFTLHFCQUFxQixTQUFpQztBQUM3RCxRQUFNLFVBQVcsUUFBaUMsVUFBVTtBQUM1RCxTQUFPO0FBQ1Q7QUFFQSxLQUFLLCtEQUErRCxNQUFNO0FBQ3hFLFNBQU8sVUFBVSxzQ0FBc0MsY0FBYyxHQUFHLENBQUMsbUJBQW1CLENBQUM7QUFDL0YsQ0FBQztBQUVELEtBQUssNkRBQTZELE1BQU07QUFDdEUsU0FBTyxVQUFVLG9DQUFvQyxjQUFjLEdBQUcsQ0FBQyxtQkFBbUIsQ0FBQztBQUM3RixDQUFDO0FBRUQsS0FBSyxnRUFBZ0UsTUFBTTtBQUN6RSxRQUFNLFdBQVcsQ0FBQyxzQkFBc0IsbUJBQW1CLGtCQUFrQjtBQUM3RSxTQUFPLFVBQVUsc0NB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
