import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerHooks } from "../bootstrap/register-hooks.js";
import {
  getPendingGate,
  resetWriteGateState,
  shouldBlockContextArtifactSave
} from "../bootstrap/write-gate.js";
import { toRoundResultResponse } from "../../remote-questions/manager.js";
function makeTempDir(prefix) {
  const dir = join(
    tmpdir(),
    `gsd-depth-gate-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}
test("register-hooks unlocks milestone depth verification from question id without guided-flow state (#4047)", async (t) => {
  const dir = makeTempDir("manual");
  const originalCwd = process.cwd();
  process.chdir(dir);
  resetWriteGateState(dir);
  t.after(() => {
    try {
      resetWriteGateState(dir);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const handlers = /* @__PURE__ */ new Map();
  const pi = {
    on(event, handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    }
  };
  registerHooks(pi, []);
  const questionId = "depth_verification_M001_confirm";
  const questions = [
    {
      id: questionId,
      question: "Do you agree?",
      options: [
        { label: "Yes, you got it (Recommended)" },
        { label: "Needs adjustment" }
      ]
    }
  ];
  const toolCallHandlers = handlers.get("tool_call");
  const toolResultHandlers = handlers.get("tool_result");
  assert.ok(toolCallHandlers?.length, "tool_call handler should be registered");
  assert.ok(toolResultHandlers?.length, "tool_result handler should be registered");
  for (const handler of toolCallHandlers ?? []) {
    await handler({
      toolName: "ask_user_questions",
      input: { questions }
    });
  }
  assert.equal(getPendingGate(), questionId, "gate should be set even without guided-flow state");
  assert.equal(
    shouldBlockContextArtifactSave("CONTEXT", "M001").block,
    true,
    "milestone context should still be blocked before confirmation"
  );
  for (const handler of toolResultHandlers ?? []) {
    await handler({
      toolName: "ask_user_questions",
      input: { questions },
      details: {
        response: {
          answers: {
            [questionId]: { selected: "Yes, you got it (Recommended)" }
          }
        }
      }
    });
  }
  assert.equal(getPendingGate(), null, "confirming the depth question should clear the pending gate");
  assert.equal(
    shouldBlockContextArtifactSave("CONTEXT", "M001").block,
    false,
    "question-id milestone inference should unlock the matching milestone context write"
  );
});
test("register-hooks clears depth gate when remote (Telegram/Slack/Discord) answer is normalized (#4406)", async (t) => {
  const dir = makeTempDir("remote");
  const originalCwd = process.cwd();
  process.chdir(dir);
  resetWriteGateState(dir);
  t.after(() => {
    try {
      resetWriteGateState(dir);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const handlers = /* @__PURE__ */ new Map();
  const pi = {
    on(event, handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    }
  };
  registerHooks(pi, []);
  const questionId = "depth_verification_M002_confirm";
  const questions = [
    {
      id: questionId,
      question: "Do you agree?",
      options: [
        { label: "Yes, you got it (Recommended)" },
        { label: "Needs adjustment" }
      ]
    }
  ];
  for (const handler of handlers.get("tool_call") ?? []) {
    await handler({ toolName: "ask_user_questions", input: { questions } });
  }
  assert.equal(getPendingGate(), questionId);
  const remoteAnswer = {
    answers: {
      [questionId]: { answers: ["Yes, you got it (Recommended)"] }
    }
  };
  const normalized = toRoundResultResponse(remoteAnswer);
  for (const handler of handlers.get("tool_result") ?? []) {
    await handler({
      toolName: "ask_user_questions",
      input: { questions },
      details: { response: normalized }
    });
  }
  assert.equal(getPendingGate(), null, "normalized remote answer must clear the gate");
  assert.equal(
    shouldBlockContextArtifactSave("CONTEXT", "M002").block,
    false,
    "remote confirmation must unlock the matching milestone context write"
  );
});
test("register-hooks returns hard blocker when depth question is cancelled", async (t) => {
  const dir = makeTempDir("cancelled");
  const originalCwd = process.cwd();
  process.chdir(dir);
  resetWriteGateState(dir);
  t.after(() => {
    try {
      resetWriteGateState(dir);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const handlers = /* @__PURE__ */ new Map();
  const pi = {
    on(event, handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    }
  };
  registerHooks(pi, []);
  const questionId = "depth_verification_M003_confirm";
  const questions = [
    {
      id: questionId,
      question: "Did I capture this correctly?",
      options: [
        { label: "Yes, you got it (Recommended)" },
        { label: "Needs adjustment" }
      ]
    }
  ];
  for (const handler of handlers.get("tool_call") ?? []) {
    await handler({ toolName: "ask_user_questions", input: { questions } });
  }
  assert.equal(getPendingGate(), questionId);
  let patch;
  for (const handler of handlers.get("tool_result") ?? []) {
    const result = await handler({
      toolName: "ask_user_questions",
      input: { questions },
      details: { cancelled: true, response: null }
    });
    if (result) patch = result;
  }
  assert.equal(getPendingGate(), questionId, "cancelled question must leave gate pending");
  assert.match(
    patch?.content?.[0]?.text ?? "",
    /HARD BLOCK: approval gate "depth_verification_M003_confirm" is still pending/
  );
  assert.match(
    patch?.content?.[0]?.text ?? "",
    /Do not infer approval from earlier or prior messages/
  );
  assert.match(
    patch?.content?.[0]?.text ?? "",
    /Re-call ask_user_questions with the same gate question id/,
    "must instruct the agent to re-ask via ask_user_questions"
  );
  assert.doesNotMatch(
    patch?.content?.[0]?.text ?? "",
    /confirm in plain chat, then stop/,
    "must not direct the agent down the prior dead-end plain-chat-and-stop path"
  );
});
test("register-hooks recovers from a cancelled depth question via re-asked ask_user_questions (milestone-hang regression)", async (t) => {
  const dir = makeTempDir("recovery");
  const originalCwd = process.cwd();
  process.chdir(dir);
  resetWriteGateState(dir);
  t.after(() => {
    try {
      resetWriteGateState(dir);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const handlers = /* @__PURE__ */ new Map();
  const pi = {
    on(event, handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    }
  };
  registerHooks(pi, []);
  const questionId = "depth_verification_M001_confirm";
  const questions = [
    {
      id: questionId,
      question: "Did I capture the project correctly?",
      options: [
        { label: "Yes, you got it (Recommended)" },
        { label: "Not quite \u2014 let me clarify" }
      ]
    }
  ];
  for (const handler of handlers.get("tool_call") ?? []) {
    await handler({ toolName: "ask_user_questions", input: { questions } });
  }
  assert.equal(getPendingGate(), questionId, "initial ask must set the gate");
  for (const handler of handlers.get("tool_result") ?? []) {
    await handler({
      toolName: "ask_user_questions",
      input: { questions },
      details: { cancelled: true, response: null }
    });
  }
  assert.equal(getPendingGate(), questionId, "cancelled response must leave gate pending");
  const reaskBlocks = [];
  for (const handler of handlers.get("tool_call") ?? []) {
    const result = await handler({ toolName: "ask_user_questions", input: { questions } });
    if (result?.block) reaskBlocks.push(result);
  }
  assert.equal(
    reaskBlocks.length,
    0,
    "immediate identical re-ask must not be blocked by the tool-call loop guard"
  );
  for (const handler of handlers.get("tool_result") ?? []) {
    await handler({
      toolName: "ask_user_questions",
      input: { questions },
      details: {
        response: {
          answers: {
            [questionId]: { selected: "Yes, you got it (Recommended)" }
          }
        }
      }
    });
  }
  assert.equal(getPendingGate(), null, "confirming re-ask must clear the gate");
  assert.equal(
    shouldBlockContextArtifactSave("CONTEXT", "M001").block,
    false,
    "context save must unlock after recovery"
  );
});
test("register-hooks gates MCP ask_user_questions cancellation before requirement saves", async (t) => {
  const dir = makeTempDir("mcp-cancelled");
  const originalCwd = process.cwd();
  process.chdir(dir);
  resetWriteGateState(dir);
  t.after(() => {
    try {
      resetWriteGateState(dir);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const handlers = /* @__PURE__ */ new Map();
  const pi = {
    on(event, handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    }
  };
  registerHooks(pi, []);
  const questionId = "depth_verification_requirements_confirm";
  const questions = [
    {
      id: questionId,
      question: "Are these the right requirements at the right scope?",
      options: [
        { label: "Yes, ship it (Recommended)" },
        { label: "Not quite \u2014 let me adjust" }
      ]
    }
  ];
  const askBlocks = [];
  for (const handler of handlers.get("tool_call") ?? []) {
    const result = await handler({
      toolName: "mcp__gsd-workflow__ask_user_questions",
      input: { questions }
    });
    if (result) askBlocks.push(result);
  }
  assert.equal(getPendingGate(), questionId, "MCP ask_user_questions should set the pending gate");
  assert.equal(
    askBlocks.some((result) => result?.block === true),
    false,
    "the gate-setting MCP ask_user_questions call itself should be allowed"
  );
  let hardBlock;
  for (const handler of handlers.get("tool_result") ?? []) {
    const result = await handler({
      toolName: "mcp__gsd-workflow__ask_user_questions",
      input: { questions },
      details: { cancelled: true, response: null }
    });
    if (result) hardBlock = result;
  }
  assert.equal(getPendingGate(), questionId, "cancelled MCP question must leave gate pending");
  assert.match(
    hardBlock?.content?.[0]?.text ?? "",
    /approval gate "depth_verification_requirements_confirm" is still pending/
  );
  let toolSearchBlock;
  for (const handler of handlers.get("tool_call") ?? []) {
    const result = await handler({
      toolName: "ToolSearch",
      input: { query: "select:mcp__gsd-workflow__gsd_requirement_save", max_results: 2 }
    });
    if (result?.block) toolSearchBlock = result;
  }
  assert.equal(toolSearchBlock?.block, true, "ToolSearch must not bury a pending approval question");
  let requirementBlock;
  for (const handler of handlers.get("tool_call") ?? []) {
    const result = await handler({
      toolName: "mcp__gsd-workflow__gsd_requirement_save",
      input: {
        class: "functional",
        description: "User can add tasks to the todo list",
        why: "Primary product value",
        source: "primary-user-loop"
      }
    });
    if (result?.block) requirementBlock = result;
  }
  assert.equal(requirementBlock?.block, true, "requirement save must be blocked while gate is pending");
  assert.match(requirementBlock?.reason ?? "", /has not been confirmed/);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9yZWdpc3Rlci1ob29rcy1kZXB0aC12ZXJpZmljYXRpb24udGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHJtU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHsgcmVnaXN0ZXJIb29rcyB9IGZyb20gXCIuLi9ib290c3RyYXAvcmVnaXN0ZXItaG9va3MudHNcIjtcbmltcG9ydCB7XG4gIGdldFBlbmRpbmdHYXRlLFxuICByZXNldFdyaXRlR2F0ZVN0YXRlLFxuICBzaG91bGRCbG9ja0NvbnRleHRBcnRpZmFjdFNhdmUsXG59IGZyb20gXCIuLi9ib290c3RyYXAvd3JpdGUtZ2F0ZS50c1wiO1xuaW1wb3J0IHsgdG9Sb3VuZFJlc3VsdFJlc3BvbnNlIH0gZnJvbSBcIi4uLy4uL3JlbW90ZS1xdWVzdGlvbnMvbWFuYWdlci50c1wiO1xuXG5mdW5jdGlvbiBtYWtlVGVtcERpcihwcmVmaXg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGRpciA9IGpvaW4oXG4gICAgdG1wZGlyKCksXG4gICAgYGdzZC1kZXB0aC1nYXRlLSR7cHJlZml4fS0ke0RhdGUubm93KCl9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YCxcbiAgKTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBkaXI7XG59XG5cbnRlc3QoXCJyZWdpc3Rlci1ob29rcyB1bmxvY2tzIG1pbGVzdG9uZSBkZXB0aCB2ZXJpZmljYXRpb24gZnJvbSBxdWVzdGlvbiBpZCB3aXRob3V0IGd1aWRlZC1mbG93IHN0YXRlICgjNDA0NylcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJtYW51YWxcIik7XG4gIGNvbnN0IG9yaWdpbmFsQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgcHJvY2Vzcy5jaGRpcihkaXIpO1xuICByZXNldFdyaXRlR2F0ZVN0YXRlKGRpcik7XG5cbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHJlc2V0V3JpdGVHYXRlU3RhdGUoZGlyKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcHJvY2Vzcy5jaGRpcihvcmlnaW5hbEN3ZCk7XG4gICAgICBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICBjb25zdCBoYW5kbGVycyA9IG5ldyBNYXA8c3RyaW5nLCBBcnJheTwoZXZlbnQ6IGFueSwgY3R4PzogYW55KSA9PiBQcm9taXNlPHZvaWQ+IHwgdm9pZD4+KCk7XG4gIGNvbnN0IHBpID0ge1xuICAgIG9uKGV2ZW50OiBzdHJpbmcsIGhhbmRsZXI6IChldmVudDogYW55LCBjdHg/OiBhbnkpID0+IFByb21pc2U8dm9pZD4gfCB2b2lkKSB7XG4gICAgICBjb25zdCBleGlzdGluZyA9IGhhbmRsZXJzLmdldChldmVudCkgPz8gW107XG4gICAgICBleGlzdGluZy5wdXNoKGhhbmRsZXIpO1xuICAgICAgaGFuZGxlcnMuc2V0KGV2ZW50LCBleGlzdGluZyk7XG4gICAgfSxcbiAgfSBhcyBhbnk7XG5cbiAgcmVnaXN0ZXJIb29rcyhwaSwgW10pO1xuXG4gIGNvbnN0IHF1ZXN0aW9uSWQgPSBcImRlcHRoX3ZlcmlmaWNhdGlvbl9NMDAxX2NvbmZpcm1cIjtcbiAgY29uc3QgcXVlc3Rpb25zID0gW1xuICAgIHtcbiAgICAgIGlkOiBxdWVzdGlvbklkLFxuICAgICAgcXVlc3Rpb246IFwiRG8geW91IGFncmVlP1wiLFxuICAgICAgb3B0aW9uczogW1xuICAgICAgICB7IGxhYmVsOiBcIlllcywgeW91IGdvdCBpdCAoUmVjb21tZW5kZWQpXCIgfSxcbiAgICAgICAgeyBsYWJlbDogXCJOZWVkcyBhZGp1c3RtZW50XCIgfSxcbiAgICAgIF0sXG4gICAgfSxcbiAgXTtcblxuICBjb25zdCB0b29sQ2FsbEhhbmRsZXJzID0gaGFuZGxlcnMuZ2V0KFwidG9vbF9jYWxsXCIpO1xuICBjb25zdCB0b29sUmVzdWx0SGFuZGxlcnMgPSBoYW5kbGVycy5nZXQoXCJ0b29sX3Jlc3VsdFwiKTtcbiAgYXNzZXJ0Lm9rKHRvb2xDYWxsSGFuZGxlcnM/Lmxlbmd0aCwgXCJ0b29sX2NhbGwgaGFuZGxlciBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcbiAgYXNzZXJ0Lm9rKHRvb2xSZXN1bHRIYW5kbGVycz8ubGVuZ3RoLCBcInRvb2xfcmVzdWx0IGhhbmRsZXIgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG5cbiAgZm9yIChjb25zdCBoYW5kbGVyIG9mIHRvb2xDYWxsSGFuZGxlcnMgPz8gW10pIHtcbiAgICBhd2FpdCBoYW5kbGVyKHtcbiAgICAgIHRvb2xOYW1lOiBcImFza191c2VyX3F1ZXN0aW9uc1wiLFxuICAgICAgaW5wdXQ6IHsgcXVlc3Rpb25zIH0sXG4gICAgfSk7XG4gIH1cblxuICBhc3NlcnQuZXF1YWwoZ2V0UGVuZGluZ0dhdGUoKSwgcXVlc3Rpb25JZCwgXCJnYXRlIHNob3VsZCBiZSBzZXQgZXZlbiB3aXRob3V0IGd1aWRlZC1mbG93IHN0YXRlXCIpO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgc2hvdWxkQmxvY2tDb250ZXh0QXJ0aWZhY3RTYXZlKFwiQ09OVEVYVFwiLCBcIk0wMDFcIikuYmxvY2ssXG4gICAgdHJ1ZSxcbiAgICBcIm1pbGVzdG9uZSBjb250ZXh0IHNob3VsZCBzdGlsbCBiZSBibG9ja2VkIGJlZm9yZSBjb25maXJtYXRpb25cIixcbiAgKTtcblxuICBmb3IgKGNvbnN0IGhhbmRsZXIgb2YgdG9vbFJlc3VsdEhhbmRsZXJzID8/IFtdKSB7XG4gICAgYXdhaXQgaGFuZGxlcih7XG4gICAgICB0b29sTmFtZTogXCJhc2tfdXNlcl9xdWVzdGlvbnNcIixcbiAgICAgIGlucHV0OiB7IHF1ZXN0aW9ucyB9LFxuICAgICAgZGV0YWlsczoge1xuICAgICAgICByZXNwb25zZToge1xuICAgICAgICAgIGFuc3dlcnM6IHtcbiAgICAgICAgICAgIFtxdWVzdGlvbklkXTogeyBzZWxlY3RlZDogXCJZZXMsIHlvdSBnb3QgaXQgKFJlY29tbWVuZGVkKVwiIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSk7XG4gIH1cblxuICBhc3NlcnQuZXF1YWwoZ2V0UGVuZGluZ0dhdGUoKSwgbnVsbCwgXCJjb25maXJtaW5nIHRoZSBkZXB0aCBxdWVzdGlvbiBzaG91bGQgY2xlYXIgdGhlIHBlbmRpbmcgZ2F0ZVwiKTtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIHNob3VsZEJsb2NrQ29udGV4dEFydGlmYWN0U2F2ZShcIkNPTlRFWFRcIiwgXCJNMDAxXCIpLmJsb2NrLFxuICAgIGZhbHNlLFxuICAgIFwicXVlc3Rpb24taWQgbWlsZXN0b25lIGluZmVyZW5jZSBzaG91bGQgdW5sb2NrIHRoZSBtYXRjaGluZyBtaWxlc3RvbmUgY29udGV4dCB3cml0ZVwiLFxuICApO1xufSk7XG5cbnRlc3QoXCJyZWdpc3Rlci1ob29rcyBjbGVhcnMgZGVwdGggZ2F0ZSB3aGVuIHJlbW90ZSAoVGVsZWdyYW0vU2xhY2svRGlzY29yZCkgYW5zd2VyIGlzIG5vcm1hbGl6ZWQgKCM0NDA2KVwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInJlbW90ZVwiKTtcbiAgY29uc3Qgb3JpZ2luYWxDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBwcm9jZXNzLmNoZGlyKGRpcik7XG4gIHJlc2V0V3JpdGVHYXRlU3RhdGUoZGlyKTtcblxuICB0LmFmdGVyKCgpID0+IHtcbiAgICB0cnkge1xuICAgICAgcmVzZXRXcml0ZUdhdGVTdGF0ZShkaXIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQ3dkKTtcbiAgICAgIHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIGNvbnN0IGhhbmRsZXJzID0gbmV3IE1hcDxzdHJpbmcsIEFycmF5PChldmVudDogYW55LCBjdHg/OiBhbnkpID0+IFByb21pc2U8dm9pZD4gfCB2b2lkPj4oKTtcbiAgY29uc3QgcGkgPSB7XG4gICAgb24oZXZlbnQ6IHN0cmluZywgaGFuZGxlcjogKGV2ZW50OiBhbnksIGN0eD86IGFueSkgPT4gUHJvbWlzZTx2b2lkPiB8IHZvaWQpIHtcbiAgICAgIGNvbnN0IGV4aXN0aW5nID0gaGFuZGxlcnMuZ2V0KGV2ZW50KSA/PyBbXTtcbiAgICAgIGV4aXN0aW5nLnB1c2goaGFuZGxlcik7XG4gICAgICBoYW5kbGVycy5zZXQoZXZlbnQsIGV4aXN0aW5nKTtcbiAgICB9LFxuICB9IGFzIGFueTtcblxuICByZWdpc3Rlckhvb2tzKHBpLCBbXSk7XG5cbiAgY29uc3QgcXVlc3Rpb25JZCA9IFwiZGVwdGhfdmVyaWZpY2F0aW9uX00wMDJfY29uZmlybVwiO1xuICBjb25zdCBxdWVzdGlvbnMgPSBbXG4gICAge1xuICAgICAgaWQ6IHF1ZXN0aW9uSWQsXG4gICAgICBxdWVzdGlvbjogXCJEbyB5b3UgYWdyZWU/XCIsXG4gICAgICBvcHRpb25zOiBbXG4gICAgICAgIHsgbGFiZWw6IFwiWWVzLCB5b3UgZ290IGl0IChSZWNvbW1lbmRlZClcIiB9LFxuICAgICAgICB7IGxhYmVsOiBcIk5lZWRzIGFkanVzdG1lbnRcIiB9LFxuICAgICAgXSxcbiAgICB9LFxuICBdO1xuXG4gIGZvciAoY29uc3QgaGFuZGxlciBvZiBoYW5kbGVycy5nZXQoXCJ0b29sX2NhbGxcIikgPz8gW10pIHtcbiAgICBhd2FpdCBoYW5kbGVyKHsgdG9vbE5hbWU6IFwiYXNrX3VzZXJfcXVlc3Rpb25zXCIsIGlucHV0OiB7IHF1ZXN0aW9ucyB9IH0pO1xuICB9XG4gIGFzc2VydC5lcXVhbChnZXRQZW5kaW5nR2F0ZSgpLCBxdWVzdGlvbklkKTtcblxuICAvLyBTaW11bGF0ZSB0aGUgbm9ybWFsaXplZCByZXNwb25zZSB0aGUgcmVtb3RlIG1hbmFnZXIgbm93IGVtaXRzOlxuICAvLyBhIFRlbGVncmFtIGJ1dHRvbiBwcmVzcyByZXR1cm5zIGEgUmVtb3RlQW5zd2VyIHRoYXQgaXMgZmVkIHRocm91Z2hcbiAgLy8gdG9Sb3VuZFJlc3VsdFJlc3BvbnNlIGJlZm9yZSByZWFjaGluZyBkZXRhaWxzLnJlc3BvbnNlLlxuICBjb25zdCByZW1vdGVBbnN3ZXIgPSB7XG4gICAgYW5zd2Vyczoge1xuICAgICAgW3F1ZXN0aW9uSWRdOiB7IGFuc3dlcnM6IFtcIlllcywgeW91IGdvdCBpdCAoUmVjb21tZW5kZWQpXCJdIH0sXG4gICAgfSxcbiAgfTtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IHRvUm91bmRSZXN1bHRSZXNwb25zZShyZW1vdGVBbnN3ZXIpO1xuXG4gIGZvciAoY29uc3QgaGFuZGxlciBvZiBoYW5kbGVycy5nZXQoXCJ0b29sX3Jlc3VsdFwiKSA/PyBbXSkge1xuICAgIGF3YWl0IGhhbmRsZXIoe1xuICAgICAgdG9vbE5hbWU6IFwiYXNrX3VzZXJfcXVlc3Rpb25zXCIsXG4gICAgICBpbnB1dDogeyBxdWVzdGlvbnMgfSxcbiAgICAgIGRldGFpbHM6IHsgcmVzcG9uc2U6IG5vcm1hbGl6ZWQgfSxcbiAgICB9KTtcbiAgfVxuXG4gIGFzc2VydC5lcXVhbChnZXRQZW5kaW5nR2F0ZSgpLCBudWxsLCBcIm5vcm1hbGl6ZWQgcmVtb3RlIGFuc3dlciBtdXN0IGNsZWFyIHRoZSBnYXRlXCIpO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgc2hvdWxkQmxvY2tDb250ZXh0QXJ0aWZhY3RTYXZlKFwiQ09OVEVYVFwiLCBcIk0wMDJcIikuYmxvY2ssXG4gICAgZmFsc2UsXG4gICAgXCJyZW1vdGUgY29uZmlybWF0aW9uIG11c3QgdW5sb2NrIHRoZSBtYXRjaGluZyBtaWxlc3RvbmUgY29udGV4dCB3cml0ZVwiLFxuICApO1xufSk7XG5cbnRlc3QoXCJyZWdpc3Rlci1ob29rcyByZXR1cm5zIGhhcmQgYmxvY2tlciB3aGVuIGRlcHRoIHF1ZXN0aW9uIGlzIGNhbmNlbGxlZFwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcImNhbmNlbGxlZFwiKTtcbiAgY29uc3Qgb3JpZ2luYWxDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBwcm9jZXNzLmNoZGlyKGRpcik7XG4gIHJlc2V0V3JpdGVHYXRlU3RhdGUoZGlyKTtcblxuICB0LmFmdGVyKCgpID0+IHtcbiAgICB0cnkge1xuICAgICAgcmVzZXRXcml0ZUdhdGVTdGF0ZShkaXIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQ3dkKTtcbiAgICAgIHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIGNvbnN0IGhhbmRsZXJzID0gbmV3IE1hcDxzdHJpbmcsIEFycmF5PChldmVudDogYW55LCBjdHg/OiBhbnkpID0+IFByb21pc2U8YW55PiB8IGFueT4+KCk7XG4gIGNvbnN0IHBpID0ge1xuICAgIG9uKGV2ZW50OiBzdHJpbmcsIGhhbmRsZXI6IChldmVudDogYW55LCBjdHg/OiBhbnkpID0+IFByb21pc2U8YW55PiB8IGFueSkge1xuICAgICAgY29uc3QgZXhpc3RpbmcgPSBoYW5kbGVycy5nZXQoZXZlbnQpID8/IFtdO1xuICAgICAgZXhpc3RpbmcucHVzaChoYW5kbGVyKTtcbiAgICAgIGhhbmRsZXJzLnNldChldmVudCwgZXhpc3RpbmcpO1xuICAgIH0sXG4gIH0gYXMgYW55O1xuXG4gIHJlZ2lzdGVySG9va3MocGksIFtdKTtcblxuICBjb25zdCBxdWVzdGlvbklkID0gXCJkZXB0aF92ZXJpZmljYXRpb25fTTAwM19jb25maXJtXCI7XG4gIGNvbnN0IHF1ZXN0aW9ucyA9IFtcbiAgICB7XG4gICAgICBpZDogcXVlc3Rpb25JZCxcbiAgICAgIHF1ZXN0aW9uOiBcIkRpZCBJIGNhcHR1cmUgdGhpcyBjb3JyZWN0bHk/XCIsXG4gICAgICBvcHRpb25zOiBbXG4gICAgICAgIHsgbGFiZWw6IFwiWWVzLCB5b3UgZ290IGl0IChSZWNvbW1lbmRlZClcIiB9LFxuICAgICAgICB7IGxhYmVsOiBcIk5lZWRzIGFkanVzdG1lbnRcIiB9LFxuICAgICAgXSxcbiAgICB9LFxuICBdO1xuXG4gIGZvciAoY29uc3QgaGFuZGxlciBvZiBoYW5kbGVycy5nZXQoXCJ0b29sX2NhbGxcIikgPz8gW10pIHtcbiAgICBhd2FpdCBoYW5kbGVyKHsgdG9vbE5hbWU6IFwiYXNrX3VzZXJfcXVlc3Rpb25zXCIsIGlucHV0OiB7IHF1ZXN0aW9ucyB9IH0pO1xuICB9XG4gIGFzc2VydC5lcXVhbChnZXRQZW5kaW5nR2F0ZSgpLCBxdWVzdGlvbklkKTtcblxuICBsZXQgcGF0Y2g6IGFueTtcbiAgZm9yIChjb25zdCBoYW5kbGVyIG9mIGhhbmRsZXJzLmdldChcInRvb2xfcmVzdWx0XCIpID8/IFtdKSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlcih7XG4gICAgICB0b29sTmFtZTogXCJhc2tfdXNlcl9xdWVzdGlvbnNcIixcbiAgICAgIGlucHV0OiB7IHF1ZXN0aW9ucyB9LFxuICAgICAgZGV0YWlsczogeyBjYW5jZWxsZWQ6IHRydWUsIHJlc3BvbnNlOiBudWxsIH0sXG4gICAgfSk7XG4gICAgaWYgKHJlc3VsdCkgcGF0Y2ggPSByZXN1bHQ7XG4gIH1cblxuICBhc3NlcnQuZXF1YWwoZ2V0UGVuZGluZ0dhdGUoKSwgcXVlc3Rpb25JZCwgXCJjYW5jZWxsZWQgcXVlc3Rpb24gbXVzdCBsZWF2ZSBnYXRlIHBlbmRpbmdcIik7XG4gIGFzc2VydC5tYXRjaChcbiAgICBwYXRjaD8uY29udGVudD8uWzBdPy50ZXh0ID8/IFwiXCIsXG4gICAgL0hBUkQgQkxPQ0s6IGFwcHJvdmFsIGdhdGUgXCJkZXB0aF92ZXJpZmljYXRpb25fTTAwM19jb25maXJtXCIgaXMgc3RpbGwgcGVuZGluZy8sXG4gICk7XG4gIGFzc2VydC5tYXRjaChcbiAgICBwYXRjaD8uY29udGVudD8uWzBdPy50ZXh0ID8/IFwiXCIsXG4gICAgL0RvIG5vdCBpbmZlciBhcHByb3ZhbCBmcm9tIGVhcmxpZXIgb3IgcHJpb3IgbWVzc2FnZXMvLFxuICApO1xuICAvLyBSZWdyZXNzaW9uIGZvciBtaWxlc3RvbmUtaGFuZzogdGhlIGNhbmNlbGxlZC1nYXRlIGluc3RydWN0aW9uIG11c3QgZGlyZWN0XG4gIC8vIHRoZSBhZ2VudCB0b3dhcmQgdGhlIG1vc3QgcmVsaWFibGUgcmVjb3ZlcnkgcGF0aCBcdTIwMTQgcmUtY2FsbGluZ1xuICAvLyBhc2tfdXNlcl9xdWVzdGlvbnMgd2l0aCB0aGUgc2FtZSBnYXRlIGlkLiBUaGUgcGxhaW4tdGV4dCBwYXRoIGFsc28gY2xlYXJzXG4gIC8vIHRoZSBnYXRlIHZpYSBpc0V4cGxpY2l0QXBwcm92YWxSZXNwb25zZSBvbiB0aGUgbmV4dCBiZWZvcmVfYWdlbnRfc3RhcnQsXG4gIC8vIGJ1dCB0aGUgc3RydWN0dXJlZCByZS1hc2sgaXMgbW9yZSBkZXRlcm1pbmlzdGljLCBzbyB0aGUgbWVzc2FnZSBwb2ludHNcbiAgLy8gdGhlcmUgYW5kIGF2b2lkcyB0aGUgcHJpb3IgZGVhZC1lbmQgXCJhc2sgaW4gcGxhaW4gY2hhdCwgdGhlbiBzdG9wXCIgd29yZGluZy5cbiAgYXNzZXJ0Lm1hdGNoKFxuICAgIHBhdGNoPy5jb250ZW50Py5bMF0/LnRleHQgPz8gXCJcIixcbiAgICAvUmUtY2FsbCBhc2tfdXNlcl9xdWVzdGlvbnMgd2l0aCB0aGUgc2FtZSBnYXRlIHF1ZXN0aW9uIGlkLyxcbiAgICBcIm11c3QgaW5zdHJ1Y3QgdGhlIGFnZW50IHRvIHJlLWFzayB2aWEgYXNrX3VzZXJfcXVlc3Rpb25zXCIsXG4gICk7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2goXG4gICAgcGF0Y2g/LmNvbnRlbnQ/LlswXT8udGV4dCA/PyBcIlwiLFxuICAgIC9jb25maXJtIGluIHBsYWluIGNoYXQsIHRoZW4gc3RvcC8sXG4gICAgXCJtdXN0IG5vdCBkaXJlY3QgdGhlIGFnZW50IGRvd24gdGhlIHByaW9yIGRlYWQtZW5kIHBsYWluLWNoYXQtYW5kLXN0b3AgcGF0aFwiLFxuICApO1xufSk7XG5cbnRlc3QoXCJyZWdpc3Rlci1ob29rcyByZWNvdmVycyBmcm9tIGEgY2FuY2VsbGVkIGRlcHRoIHF1ZXN0aW9uIHZpYSByZS1hc2tlZCBhc2tfdXNlcl9xdWVzdGlvbnMgKG1pbGVzdG9uZS1oYW5nIHJlZ3Jlc3Npb24pXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwicmVjb3ZlcnlcIik7XG4gIGNvbnN0IG9yaWdpbmFsQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgcHJvY2Vzcy5jaGRpcihkaXIpO1xuICByZXNldFdyaXRlR2F0ZVN0YXRlKGRpcik7XG5cbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHJlc2V0V3JpdGVHYXRlU3RhdGUoZGlyKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcHJvY2Vzcy5jaGRpcihvcmlnaW5hbEN3ZCk7XG4gICAgICBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICBjb25zdCBoYW5kbGVycyA9IG5ldyBNYXA8c3RyaW5nLCBBcnJheTwoZXZlbnQ6IGFueSwgY3R4PzogYW55KSA9PiBQcm9taXNlPGFueT4gfCBhbnk+PigpO1xuICBjb25zdCBwaSA9IHtcbiAgICBvbihldmVudDogc3RyaW5nLCBoYW5kbGVyOiAoZXZlbnQ6IGFueSwgY3R4PzogYW55KSA9PiBQcm9taXNlPGFueT4gfCBhbnkpIHtcbiAgICAgIGNvbnN0IGV4aXN0aW5nID0gaGFuZGxlcnMuZ2V0KGV2ZW50KSA/PyBbXTtcbiAgICAgIGV4aXN0aW5nLnB1c2goaGFuZGxlcik7XG4gICAgICBoYW5kbGVycy5zZXQoZXZlbnQsIGV4aXN0aW5nKTtcbiAgICB9LFxuICB9IGFzIGFueTtcblxuICByZWdpc3Rlckhvb2tzKHBpLCBbXSk7XG5cbiAgY29uc3QgcXVlc3Rpb25JZCA9IFwiZGVwdGhfdmVyaWZpY2F0aW9uX00wMDFfY29uZmlybVwiO1xuICBjb25zdCBxdWVzdGlvbnMgPSBbXG4gICAge1xuICAgICAgaWQ6IHF1ZXN0aW9uSWQsXG4gICAgICBxdWVzdGlvbjogXCJEaWQgSSBjYXB0dXJlIHRoZSBwcm9qZWN0IGNvcnJlY3RseT9cIixcbiAgICAgIG9wdGlvbnM6IFtcbiAgICAgICAgeyBsYWJlbDogXCJZZXMsIHlvdSBnb3QgaXQgKFJlY29tbWVuZGVkKVwiIH0sXG4gICAgICAgIHsgbGFiZWw6IFwiTm90IHF1aXRlIFx1MjAxNCBsZXQgbWUgY2xhcmlmeVwiIH0sXG4gICAgICBdLFxuICAgIH0sXG4gIF07XG5cbiAgLy8gMS4gSW5pdGlhbCBhc2sgc2V0cyB0aGUgZ2F0ZS5cbiAgZm9yIChjb25zdCBoYW5kbGVyIG9mIGhhbmRsZXJzLmdldChcInRvb2xfY2FsbFwiKSA/PyBbXSkge1xuICAgIGF3YWl0IGhhbmRsZXIoeyB0b29sTmFtZTogXCJhc2tfdXNlcl9xdWVzdGlvbnNcIiwgaW5wdXQ6IHsgcXVlc3Rpb25zIH0gfSk7XG4gIH1cbiAgYXNzZXJ0LmVxdWFsKGdldFBlbmRpbmdHYXRlKCksIHF1ZXN0aW9uSWQsIFwiaW5pdGlhbCBhc2sgbXVzdCBzZXQgdGhlIGdhdGVcIik7XG5cbiAgLy8gMi4gVXNlciBjYW5jZWxzIChzaW11bGF0ZXMgdGhlIHRyYXAgZnJvbSB0aGUgc2NyZWVuc2hvdDogcXVlc3Rpb24gbmV2ZXJcbiAgLy8gICAgYW5zd2VyZWQgdGhyb3VnaCB0aGUgc3RydWN0dXJlZCBjaGFubmVsKS4gR2F0ZSBtdXN0IHN0YXkgcGVuZGluZy5cbiAgZm9yIChjb25zdCBoYW5kbGVyIG9mIGhhbmRsZXJzLmdldChcInRvb2xfcmVzdWx0XCIpID8/IFtdKSB7XG4gICAgYXdhaXQgaGFuZGxlcih7XG4gICAgICB0b29sTmFtZTogXCJhc2tfdXNlcl9xdWVzdGlvbnNcIixcbiAgICAgIGlucHV0OiB7IHF1ZXN0aW9ucyB9LFxuICAgICAgZGV0YWlsczogeyBjYW5jZWxsZWQ6IHRydWUsIHJlc3BvbnNlOiBudWxsIH0sXG4gICAgfSk7XG4gIH1cbiAgYXNzZXJ0LmVxdWFsKGdldFBlbmRpbmdHYXRlKCksIHF1ZXN0aW9uSWQsIFwiY2FuY2VsbGVkIHJlc3BvbnNlIG11c3QgbGVhdmUgZ2F0ZSBwZW5kaW5nXCIpO1xuXG4gIC8vIDMuIFJlY292ZXJ5IHBhdGg6IGltbWVkaWF0ZWx5IHJlLWNhbGwgYXNrX3VzZXJfcXVlc3Rpb25zIHdpdGggdGhlIHNhbWVcbiAgLy8gICAgZ2F0ZSBpZCBhbmQgaWRlbnRpY2FsIGlucHV0LiBUaGlzIG11c3Qgbm90IGJlIGJsb2NrZWQgYnkgdGhlIHN0cmljdFxuICAvLyAgICBkdXBsaWNhdGUtY2FsbCBsb29wIGd1YXJkLCBiZWNhdXNlIHRoZSBoYXJkLWJsb2NrIGluc3RydWN0aW9uIGFib3ZlXG4gIC8vICAgIHRlbGxzIHRoZSBhZ2VudCB0byBkbyBleGFjdGx5IHRoaXMgYW5kIG5vdCB0byBpbnRlcmxlYXZlIG90aGVyIHRvb2xzLlxuICBjb25zdCByZWFza0Jsb2NrczogYW55W10gPSBbXTtcbiAgZm9yIChjb25zdCBoYW5kbGVyIG9mIGhhbmRsZXJzLmdldChcInRvb2xfY2FsbFwiKSA/PyBbXSkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZXIoeyB0b29sTmFtZTogXCJhc2tfdXNlcl9xdWVzdGlvbnNcIiwgaW5wdXQ6IHsgcXVlc3Rpb25zIH0gfSk7XG4gICAgaWYgKHJlc3VsdD8uYmxvY2spIHJlYXNrQmxvY2tzLnB1c2gocmVzdWx0KTtcbiAgfVxuICBhc3NlcnQuZXF1YWwoXG4gICAgcmVhc2tCbG9ja3MubGVuZ3RoLFxuICAgIDAsXG4gICAgXCJpbW1lZGlhdGUgaWRlbnRpY2FsIHJlLWFzayBtdXN0IG5vdCBiZSBibG9ja2VkIGJ5IHRoZSB0b29sLWNhbGwgbG9vcCBndWFyZFwiLFxuICApO1xuXG4gIC8vIDQuIFRoZSByZS1hc2tlZCBxdWVzdGlvbiByZWNlaXZlcyBhIGNvbmZpcm1pbmcgcmVzcG9uc2UsIHdoaWNoIGNsZWFycyB0aGVcbiAgLy8gICAgZ2F0ZSBhbmQgdW5sb2NrcyB0aGUgbWlsZXN0b25lIGNvbnRleHQgc2F2ZS5cbiAgZm9yIChjb25zdCBoYW5kbGVyIG9mIGhhbmRsZXJzLmdldChcInRvb2xfcmVzdWx0XCIpID8/IFtdKSB7XG4gICAgYXdhaXQgaGFuZGxlcih7XG4gICAgICB0b29sTmFtZTogXCJhc2tfdXNlcl9xdWVzdGlvbnNcIixcbiAgICAgIGlucHV0OiB7IHF1ZXN0aW9ucyB9LFxuICAgICAgZGV0YWlsczoge1xuICAgICAgICByZXNwb25zZToge1xuICAgICAgICAgIGFuc3dlcnM6IHtcbiAgICAgICAgICAgIFtxdWVzdGlvbklkXTogeyBzZWxlY3RlZDogXCJZZXMsIHlvdSBnb3QgaXQgKFJlY29tbWVuZGVkKVwiIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSk7XG4gIH1cblxuICBhc3NlcnQuZXF1YWwoZ2V0UGVuZGluZ0dhdGUoKSwgbnVsbCwgXCJjb25maXJtaW5nIHJlLWFzayBtdXN0IGNsZWFyIHRoZSBnYXRlXCIpO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgc2hvdWxkQmxvY2tDb250ZXh0QXJ0aWZhY3RTYXZlKFwiQ09OVEVYVFwiLCBcIk0wMDFcIikuYmxvY2ssXG4gICAgZmFsc2UsXG4gICAgXCJjb250ZXh0IHNhdmUgbXVzdCB1bmxvY2sgYWZ0ZXIgcmVjb3ZlcnlcIixcbiAgKTtcbn0pO1xuXG50ZXN0KFwicmVnaXN0ZXItaG9va3MgZ2F0ZXMgTUNQIGFza191c2VyX3F1ZXN0aW9ucyBjYW5jZWxsYXRpb24gYmVmb3JlIHJlcXVpcmVtZW50IHNhdmVzXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwibWNwLWNhbmNlbGxlZFwiKTtcbiAgY29uc3Qgb3JpZ2luYWxDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBwcm9jZXNzLmNoZGlyKGRpcik7XG4gIHJlc2V0V3JpdGVHYXRlU3RhdGUoZGlyKTtcblxuICB0LmFmdGVyKCgpID0+IHtcbiAgICB0cnkge1xuICAgICAgcmVzZXRXcml0ZUdhdGVTdGF0ZShkaXIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQ3dkKTtcbiAgICAgIHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIGNvbnN0IGhhbmRsZXJzID0gbmV3IE1hcDxzdHJpbmcsIEFycmF5PChldmVudDogYW55LCBjdHg/OiBhbnkpID0+IFByb21pc2U8YW55PiB8IGFueT4+KCk7XG4gIGNvbnN0IHBpID0ge1xuICAgIG9uKGV2ZW50OiBzdHJpbmcsIGhhbmRsZXI6IChldmVudDogYW55LCBjdHg/OiBhbnkpID0+IFByb21pc2U8YW55PiB8IGFueSkge1xuICAgICAgY29uc3QgZXhpc3RpbmcgPSBoYW5kbGVycy5nZXQoZXZlbnQpID8/IFtdO1xuICAgICAgZXhpc3RpbmcucHVzaChoYW5kbGVyKTtcbiAgICAgIGhhbmRsZXJzLnNldChldmVudCwgZXhpc3RpbmcpO1xuICAgIH0sXG4gIH0gYXMgYW55O1xuXG4gIHJlZ2lzdGVySG9va3MocGksIFtdKTtcblxuICBjb25zdCBxdWVzdGlvbklkID0gXCJkZXB0aF92ZXJpZmljYXRpb25fcmVxdWlyZW1lbnRzX2NvbmZpcm1cIjtcbiAgY29uc3QgcXVlc3Rpb25zID0gW1xuICAgIHtcbiAgICAgIGlkOiBxdWVzdGlvbklkLFxuICAgICAgcXVlc3Rpb246IFwiQXJlIHRoZXNlIHRoZSByaWdodCByZXF1aXJlbWVudHMgYXQgdGhlIHJpZ2h0IHNjb3BlP1wiLFxuICAgICAgb3B0aW9uczogW1xuICAgICAgICB7IGxhYmVsOiBcIlllcywgc2hpcCBpdCAoUmVjb21tZW5kZWQpXCIgfSxcbiAgICAgICAgeyBsYWJlbDogXCJOb3QgcXVpdGUgXHUyMDE0IGxldCBtZSBhZGp1c3RcIiB9LFxuICAgICAgXSxcbiAgICB9LFxuICBdO1xuXG4gIGNvbnN0IGFza0Jsb2NrczogYW55W10gPSBbXTtcbiAgZm9yIChjb25zdCBoYW5kbGVyIG9mIGhhbmRsZXJzLmdldChcInRvb2xfY2FsbFwiKSA/PyBbXSkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZXIoe1xuICAgICAgdG9vbE5hbWU6IFwibWNwX19nc2Qtd29ya2Zsb3dfX2Fza191c2VyX3F1ZXN0aW9uc1wiLFxuICAgICAgaW5wdXQ6IHsgcXVlc3Rpb25zIH0sXG4gICAgfSk7XG4gICAgaWYgKHJlc3VsdCkgYXNrQmxvY2tzLnB1c2gocmVzdWx0KTtcbiAgfVxuXG4gIGFzc2VydC5lcXVhbChnZXRQZW5kaW5nR2F0ZSgpLCBxdWVzdGlvbklkLCBcIk1DUCBhc2tfdXNlcl9xdWVzdGlvbnMgc2hvdWxkIHNldCB0aGUgcGVuZGluZyBnYXRlXCIpO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgYXNrQmxvY2tzLnNvbWUoKHJlc3VsdCkgPT4gcmVzdWx0Py5ibG9jayA9PT0gdHJ1ZSksXG4gICAgZmFsc2UsXG4gICAgXCJ0aGUgZ2F0ZS1zZXR0aW5nIE1DUCBhc2tfdXNlcl9xdWVzdGlvbnMgY2FsbCBpdHNlbGYgc2hvdWxkIGJlIGFsbG93ZWRcIixcbiAgKTtcblxuICBsZXQgaGFyZEJsb2NrOiBhbnk7XG4gIGZvciAoY29uc3QgaGFuZGxlciBvZiBoYW5kbGVycy5nZXQoXCJ0b29sX3Jlc3VsdFwiKSA/PyBbXSkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZXIoe1xuICAgICAgdG9vbE5hbWU6IFwibWNwX19nc2Qtd29ya2Zsb3dfX2Fza191c2VyX3F1ZXN0aW9uc1wiLFxuICAgICAgaW5wdXQ6IHsgcXVlc3Rpb25zIH0sXG4gICAgICBkZXRhaWxzOiB7IGNhbmNlbGxlZDogdHJ1ZSwgcmVzcG9uc2U6IG51bGwgfSxcbiAgICB9KTtcbiAgICBpZiAocmVzdWx0KSBoYXJkQmxvY2sgPSByZXN1bHQ7XG4gIH1cblxuICBhc3NlcnQuZXF1YWwoZ2V0UGVuZGluZ0dhdGUoKSwgcXVlc3Rpb25JZCwgXCJjYW5jZWxsZWQgTUNQIHF1ZXN0aW9uIG11c3QgbGVhdmUgZ2F0ZSBwZW5kaW5nXCIpO1xuICBhc3NlcnQubWF0Y2goXG4gICAgaGFyZEJsb2NrPy5jb250ZW50Py5bMF0/LnRleHQgPz8gXCJcIixcbiAgICAvYXBwcm92YWwgZ2F0ZSBcImRlcHRoX3ZlcmlmaWNhdGlvbl9yZXF1aXJlbWVudHNfY29uZmlybVwiIGlzIHN0aWxsIHBlbmRpbmcvLFxuICApO1xuXG4gIGxldCB0b29sU2VhcmNoQmxvY2s6IGFueTtcbiAgZm9yIChjb25zdCBoYW5kbGVyIG9mIGhhbmRsZXJzLmdldChcInRvb2xfY2FsbFwiKSA/PyBbXSkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZXIoe1xuICAgICAgdG9vbE5hbWU6IFwiVG9vbFNlYXJjaFwiLFxuICAgICAgaW5wdXQ6IHsgcXVlcnk6IFwic2VsZWN0Om1jcF9fZ3NkLXdvcmtmbG93X19nc2RfcmVxdWlyZW1lbnRfc2F2ZVwiLCBtYXhfcmVzdWx0czogMiB9LFxuICAgIH0pO1xuICAgIGlmIChyZXN1bHQ/LmJsb2NrKSB0b29sU2VhcmNoQmxvY2sgPSByZXN1bHQ7XG4gIH1cbiAgYXNzZXJ0LmVxdWFsKHRvb2xTZWFyY2hCbG9jaz8uYmxvY2ssIHRydWUsIFwiVG9vbFNlYXJjaCBtdXN0IG5vdCBidXJ5IGEgcGVuZGluZyBhcHByb3ZhbCBxdWVzdGlvblwiKTtcblxuICBsZXQgcmVxdWlyZW1lbnRCbG9jazogYW55O1xuICBmb3IgKGNvbnN0IGhhbmRsZXIgb2YgaGFuZGxlcnMuZ2V0KFwidG9vbF9jYWxsXCIpID8/IFtdKSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlcih7XG4gICAgICB0b29sTmFtZTogXCJtY3BfX2dzZC13b3JrZmxvd19fZ3NkX3JlcXVpcmVtZW50X3NhdmVcIixcbiAgICAgIGlucHV0OiB7XG4gICAgICAgIGNsYXNzOiBcImZ1bmN0aW9uYWxcIixcbiAgICAgICAgZGVzY3JpcHRpb246IFwiVXNlciBjYW4gYWRkIHRhc2tzIHRvIHRoZSB0b2RvIGxpc3RcIixcbiAgICAgICAgd2h5OiBcIlByaW1hcnkgcHJvZHVjdCB2YWx1ZVwiLFxuICAgICAgICBzb3VyY2U6IFwicHJpbWFyeS11c2VyLWxvb3BcIixcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgaWYgKHJlc3VsdD8uYmxvY2spIHJlcXVpcmVtZW50QmxvY2sgPSByZXN1bHQ7XG4gIH1cblxuICBhc3NlcnQuZXF1YWwocmVxdWlyZW1lbnRCbG9jaz8uYmxvY2ssIHRydWUsIFwicmVxdWlyZW1lbnQgc2F2ZSBtdXN0IGJlIGJsb2NrZWQgd2hpbGUgZ2F0ZSBpcyBwZW5kaW5nXCIpO1xuICBhc3NlcnQubWF0Y2gocmVxdWlyZW1lbnRCbG9jaz8ucmVhc29uID8/IFwiXCIsIC9oYXMgbm90IGJlZW4gY29uZmlybWVkLyk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxXQUFXLGNBQWM7QUFDbEMsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QixTQUFTLHFCQUFxQjtBQUM5QjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLDZCQUE2QjtBQUV0QyxTQUFTLFlBQVksUUFBd0I7QUFDM0MsUUFBTSxNQUFNO0FBQUEsSUFDVixPQUFPO0FBQUEsSUFDUCxrQkFBa0IsTUFBTSxJQUFJLEtBQUssSUFBSSxDQUFDLElBQUksS0FBSyxPQUFPLEVBQUUsU0FBUyxFQUFFLEVBQUUsTUFBTSxHQUFHLENBQUMsQ0FBQztBQUFBLEVB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
