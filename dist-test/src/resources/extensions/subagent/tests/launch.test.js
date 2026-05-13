import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, afterEach } from "node:test";
import { SessionManager } from "@gsd/pi-coding-agent";
import subagentExtension from "../index.js";
import {
  SUBAGENT_CHILD_ENV_VAR,
  SUBAGENT_CHILD_ENV_VALUE,
  buildSubagentProcessEnv,
  createSubagentLaunchPlan,
  isSubagentChildProcess,
  resolveSubagentSessionArgs
} from "../launch.js";
function makeAgent(overrides = {}) {
  return {
    name: "test-agent",
    description: "A test agent",
    systemPrompt: "",
    source: "project",
    filePath: "test-agent.md",
    tools: ["read", "write"],
    ...overrides
  };
}
function makeAssistantMessage() {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 2,
      cost: { total: 0 }
    }
  };
}
describe("subagent launch module", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = void 0;
  });
  it("builds fresh child process args with child environment", () => {
    const agent = makeAgent({ model: "local-model" });
    const plan = createSubagentLaunchPlan({
      agent,
      task: "inspect the API",
      tmpPromptPath: "/tmp/prompt.md",
      defaultCwd: "/repo"
    });
    assert.ok(plan.args.includes("--no-session"));
    assert.equal(plan.args.includes("--session"), false);
    assert.equal(plan.env[SUBAGENT_CHILD_ENV_VAR], SUBAGENT_CHILD_ENV_VALUE);
    assert.equal(plan.cwd, "/repo");
    assert.deepEqual(plan.session, { mode: "fresh" });
    assert.deepEqual(plan.args.slice(plan.args.indexOf("--tools"), plan.args.indexOf("--tools") + 2), ["--tools", "read,write"]);
  });
  it("creates a real branched session for forked context", () => {
    dir = mkdtempSync(join(tmpdir(), "gsd-subagent-launch-"));
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }] });
    manager.appendMessage(makeAssistantMessage());
    const session = resolveSubagentSessionArgs("fork", manager);
    assert.equal(session.mode, "fork");
    assert.ok(session.sessionFile);
    assert.notEqual(session.sessionFile, manager.getSessionFile());
    assert.equal(session.sessionDir, dir);
  });
  it("fails forked context loudly without a persisted parent session", () => {
    const manager = SessionManager.inMemory("/repo");
    assert.throws(
      () => resolveSubagentSessionArgs("fork", manager),
      /persisted parent session file/
    );
  });
  it("marks child env and suppresses recursive tool registration", () => {
    const env = buildSubagentProcessEnv({});
    assert.equal(isSubagentChildProcess(env), true);
    const previous = process.env[SUBAGENT_CHILD_ENV_VAR];
    process.env[SUBAGENT_CHILD_ENV_VAR] = SUBAGENT_CHILD_ENV_VALUE;
    const calls = [];
    try {
      subagentExtension({
        on: () => calls.push("on"),
        registerCommand: () => calls.push("command"),
        registerTool: () => calls.push("tool")
      });
    } finally {
      if (previous === void 0) delete process.env[SUBAGENT_CHILD_ENV_VAR];
      else process.env[SUBAGENT_CHILD_ENV_VAR] = previous;
    }
    assert.deepEqual(calls, []);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3N1YmFnZW50L3Rlc3RzL2xhdW5jaC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QtMiArIFN1YmFnZW50IGxhdW5jaCBtb2R1bGUgcmVncmVzc2lvbiB0ZXN0cy5cblxuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5cbmltcG9ydCB7IFNlc3Npb25NYW5hZ2VyIH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgc3ViYWdlbnRFeHRlbnNpb24gZnJvbSBcIi4uL2luZGV4LmpzXCI7XG5pbXBvcnQgdHlwZSB7IEFnZW50Q29uZmlnIH0gZnJvbSBcIi4uL2FnZW50cy5qc1wiO1xuaW1wb3J0IHtcblx0U1VCQUdFTlRfQ0hJTERfRU5WX1ZBUixcblx0U1VCQUdFTlRfQ0hJTERfRU5WX1ZBTFVFLFxuXHRidWlsZFN1YmFnZW50UHJvY2Vzc0Vudixcblx0Y3JlYXRlU3ViYWdlbnRMYXVuY2hQbGFuLFxuXHRpc1N1YmFnZW50Q2hpbGRQcm9jZXNzLFxuXHRyZXNvbHZlU3ViYWdlbnRTZXNzaW9uQXJncyxcbn0gZnJvbSBcIi4uL2xhdW5jaC5qc1wiO1xuXG5mdW5jdGlvbiBtYWtlQWdlbnQob3ZlcnJpZGVzOiBQYXJ0aWFsPEFnZW50Q29uZmlnPiA9IHt9KTogQWdlbnRDb25maWcge1xuXHRyZXR1cm4ge1xuXHRcdG5hbWU6IFwidGVzdC1hZ2VudFwiLFxuXHRcdGRlc2NyaXB0aW9uOiBcIkEgdGVzdCBhZ2VudFwiLFxuXHRcdHN5c3RlbVByb21wdDogXCJcIixcblx0XHRzb3VyY2U6IFwicHJvamVjdFwiLFxuXHRcdGZpbGVQYXRoOiBcInRlc3QtYWdlbnQubWRcIixcblx0XHR0b29sczogW1wicmVhZFwiLCBcIndyaXRlXCJdLFxuXHRcdC4uLm92ZXJyaWRlcyxcblx0fTtcbn1cblxuZnVuY3Rpb24gbWFrZUFzc2lzdGFudE1lc3NhZ2UoKSB7XG5cdHJldHVybiB7XG5cdFx0cm9sZTogXCJhc3Npc3RhbnRcIixcblx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJva1wiIH1dLFxuXHRcdHVzYWdlOiB7XG5cdFx0XHRpbnB1dDogMSxcblx0XHRcdG91dHB1dDogMSxcblx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR0b3RhbDogMixcblx0XHRcdGNvc3Q6IHsgdG90YWw6IDAgfSxcblx0XHR9LFxuXHR9IGFzIGFueTtcbn1cblxuZGVzY3JpYmUoXCJzdWJhZ2VudCBsYXVuY2ggbW9kdWxlXCIsICgpID0+IHtcblx0bGV0IGRpcjogc3RyaW5nIHwgdW5kZWZpbmVkO1xuXG5cdGFmdGVyRWFjaCgoKSA9PiB7XG5cdFx0aWYgKGRpcikgcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHRcdGRpciA9IHVuZGVmaW5lZDtcblx0fSk7XG5cblx0aXQoXCJidWlsZHMgZnJlc2ggY2hpbGQgcHJvY2VzcyBhcmdzIHdpdGggY2hpbGQgZW52aXJvbm1lbnRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGFnZW50ID0gbWFrZUFnZW50KHsgbW9kZWw6IFwibG9jYWwtbW9kZWxcIiB9KTtcblx0XHRjb25zdCBwbGFuID0gY3JlYXRlU3ViYWdlbnRMYXVuY2hQbGFuKHtcblx0XHRcdGFnZW50LFxuXHRcdFx0dGFzazogXCJpbnNwZWN0IHRoZSBBUElcIixcblx0XHRcdHRtcFByb21wdFBhdGg6IFwiL3RtcC9wcm9tcHQubWRcIixcblx0XHRcdGRlZmF1bHRDd2Q6IFwiL3JlcG9cIixcblx0XHR9KTtcblxuXHRcdGFzc2VydC5vayhwbGFuLmFyZ3MuaW5jbHVkZXMoXCItLW5vLXNlc3Npb25cIikpO1xuXHRcdGFzc2VydC5lcXVhbChwbGFuLmFyZ3MuaW5jbHVkZXMoXCItLXNlc3Npb25cIiksIGZhbHNlKTtcblx0XHRhc3NlcnQuZXF1YWwocGxhbi5lbnZbU1VCQUdFTlRfQ0hJTERfRU5WX1ZBUl0sIFNVQkFHRU5UX0NISUxEX0VOVl9WQUxVRSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHBsYW4uY3dkLCBcIi9yZXBvXCIpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwocGxhbi5zZXNzaW9uLCB7IG1vZGU6IFwiZnJlc2hcIiB9KTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHBsYW4uYXJncy5zbGljZShwbGFuLmFyZ3MuaW5kZXhPZihcIi0tdG9vbHNcIiksIHBsYW4uYXJncy5pbmRleE9mKFwiLS10b29sc1wiKSArIDIpLCBbXCItLXRvb2xzXCIsIFwicmVhZCx3cml0ZVwiXSk7XG5cdH0pO1xuXG5cdGl0KFwiY3JlYXRlcyBhIHJlYWwgYnJhbmNoZWQgc2Vzc2lvbiBmb3IgZm9ya2VkIGNvbnRleHRcIiwgKCkgPT4ge1xuXHRcdGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXN1YmFnZW50LWxhdW5jaC1cIikpO1xuXHRcdGNvbnN0IG1hbmFnZXIgPSBTZXNzaW9uTWFuYWdlci5jcmVhdGUoZGlyLCBkaXIpO1xuXHRcdG1hbmFnZXIuYXBwZW5kTWVzc2FnZSh7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJoZWxsb1wiIH1dIH0gYXMgYW55KTtcblx0XHRtYW5hZ2VyLmFwcGVuZE1lc3NhZ2UobWFrZUFzc2lzdGFudE1lc3NhZ2UoKSk7XG5cblx0XHRjb25zdCBzZXNzaW9uID0gcmVzb2x2ZVN1YmFnZW50U2Vzc2lvbkFyZ3MoXCJmb3JrXCIsIG1hbmFnZXIpO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKHNlc3Npb24ubW9kZSwgXCJmb3JrXCIpO1xuXHRcdGFzc2VydC5vayhzZXNzaW9uLnNlc3Npb25GaWxlKTtcblx0XHRhc3NlcnQubm90RXF1YWwoc2Vzc2lvbi5zZXNzaW9uRmlsZSwgbWFuYWdlci5nZXRTZXNzaW9uRmlsZSgpKTtcblx0XHRhc3NlcnQuZXF1YWwoc2Vzc2lvbi5zZXNzaW9uRGlyLCBkaXIpO1xuXHR9KTtcblxuXHRpdChcImZhaWxzIGZvcmtlZCBjb250ZXh0IGxvdWRseSB3aXRob3V0IGEgcGVyc2lzdGVkIHBhcmVudCBzZXNzaW9uXCIsICgpID0+IHtcblx0XHRjb25zdCBtYW5hZ2VyID0gU2Vzc2lvbk1hbmFnZXIuaW5NZW1vcnkoXCIvcmVwb1wiKTtcblx0XHRhc3NlcnQudGhyb3dzKFxuXHRcdFx0KCkgPT4gcmVzb2x2ZVN1YmFnZW50U2Vzc2lvbkFyZ3MoXCJmb3JrXCIsIG1hbmFnZXIpLFxuXHRcdFx0L3BlcnNpc3RlZCBwYXJlbnQgc2Vzc2lvbiBmaWxlLyxcblx0XHQpO1xuXHR9KTtcblxuXHRpdChcIm1hcmtzIGNoaWxkIGVudiBhbmQgc3VwcHJlc3NlcyByZWN1cnNpdmUgdG9vbCByZWdpc3RyYXRpb25cIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGVudiA9IGJ1aWxkU3ViYWdlbnRQcm9jZXNzRW52KHt9KTtcblx0XHRhc3NlcnQuZXF1YWwoaXNTdWJhZ2VudENoaWxkUHJvY2VzcyhlbnYpLCB0cnVlKTtcblxuXHRcdGNvbnN0IHByZXZpb3VzID0gcHJvY2Vzcy5lbnZbU1VCQUdFTlRfQ0hJTERfRU5WX1ZBUl07XG5cdFx0cHJvY2Vzcy5lbnZbU1VCQUdFTlRfQ0hJTERfRU5WX1ZBUl0gPSBTVUJBR0VOVF9DSElMRF9FTlZfVkFMVUU7XG5cdFx0Y29uc3QgY2FsbHM6IHN0cmluZ1tdID0gW107XG5cdFx0dHJ5IHtcblx0XHRcdHN1YmFnZW50RXh0ZW5zaW9uKHtcblx0XHRcdFx0b246ICgpID0+IGNhbGxzLnB1c2goXCJvblwiKSxcblx0XHRcdFx0cmVnaXN0ZXJDb21tYW5kOiAoKSA9PiBjYWxscy5wdXNoKFwiY29tbWFuZFwiKSxcblx0XHRcdFx0cmVnaXN0ZXJUb29sOiAoKSA9PiBjYWxscy5wdXNoKFwidG9vbFwiKSxcblx0XHRcdH0gYXMgYW55KTtcblx0XHR9IGZpbmFsbHkge1xuXHRcdFx0aWYgKHByZXZpb3VzID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudltTVUJBR0VOVF9DSElMRF9FTlZfVkFSXTtcblx0XHRcdGVsc2UgcHJvY2Vzcy5lbnZbU1VCQUdFTlRfQ0hJTERfRU5WX1ZBUl0gPSBwcmV2aW91cztcblx0XHR9XG5cblx0XHRhc3NlcnQuZGVlcEVxdWFsKGNhbGxzLCBbXSk7XG5cdH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFFQSxPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLGNBQWM7QUFDcEMsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsWUFBWTtBQUNyQixTQUFTLFVBQVUsSUFBSSxpQkFBaUI7QUFFeEMsU0FBUyxzQkFBc0I7QUFDL0IsT0FBTyx1QkFBdUI7QUFFOUI7QUFBQSxFQUNDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNNO0FBRVAsU0FBUyxVQUFVLFlBQWtDLENBQUMsR0FBZ0I7QUFDckUsU0FBTztBQUFBLElBQ04sTUFBTTtBQUFBLElBQ04sYUFBYTtBQUFBLElBQ2IsY0FBYztBQUFBLElBQ2QsUUFBUTtBQUFBLElBQ1IsVUFBVTtBQUFBLElBQ1YsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLEdBQUc7QUFBQSxFQUNKO0FBQ0Q7QUFFQSxTQUFTLHVCQUF1QjtBQUMvQixTQUFPO0FBQUEsSUFDTixNQUFNO0FBQUEsSUFDTixTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxLQUFLLENBQUM7QUFBQSxJQUN0QyxPQUFPO0FBQUEsTUFDTixPQUFPO0FBQUEsTUFDUCxRQUFRO0FB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
