import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@sinclair/typebox";
import {
  buildProviderPayloadAuditSummary,
  buildTokenAuditSummary,
  maybeLogProviderPayloadAudit,
  maybeLogTokenAudit
} from "./token-audit.js";
test("buildTokenAuditSummary reports payload section sizes without content fields", () => {
  const context = {
    systemPrompt: "system prompt",
    tools: [
      {
        name: "read",
        description: "Read a file",
        parameters: Type.Object({ path: Type.String() })
      },
      {
        name: "large_tool",
        description: "Large schema".repeat(20),
        parameters: Type.Object({ value: Type.String() })
      }
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "tool output" }],
        isError: false,
        timestamp: 2
      },
      { role: "user", content: [{ type: "image", data: "abc123", mimeType: "image/png" }], timestamp: 3 }
    ]
  };
  const sourceMessages = [
    ...context.messages,
    {
      role: "custom",
      customType: "gsd-memory",
      content: "memory block",
      display: false,
      timestamp: 4
    }
  ];
  const summary = buildTokenAuditSummary(context, sourceMessages);
  assert.equal(summary.systemChars, "system prompt".length);
  assert.equal(summary.toolCount, 2);
  assert.equal(summary.messageCount, 3);
  assert.equal(summary.toolResultChars, "tool output".length);
  assert.equal(summary.imageCount, 1);
  assert.ok(summary.toolSchemaChars > 0);
  assert.ok(summary.customMessageChars > 0);
  assert.ok(summary.estimatedInputTokens > 0);
  assert.deepEqual(
    summary.largestMessages.map((message) => Object.keys(message).sort()),
    summary.largestMessages.map(() => ["chars", "index", "role", "type"])
  );
  assert.equal(summary.largestTools[0].name, "large_tool");
  assert.deepEqual(
    summary.largestTools.map((tool) => Object.keys(tool).sort()),
    summary.largestTools.map(() => ["chars", "name"])
  );
  assert.deepEqual(summary.largestCustomMessages, [
    { index: 3, role: "custom", customType: "gsd-memory", chars: summary.largestCustomMessages[0].chars }
  ]);
  assert.ok(!JSON.stringify(summary).includes("tool output"));
  assert.ok(!JSON.stringify(summary).includes("memory block"));
});
test("maybeLogTokenAudit is opt-in and emits metadata only", () => {
  const original = process.env.PI_TOKEN_AUDIT;
  const originalWrite = process.stderr.write;
  let written = "";
  process.stderr.write = ((chunk) => {
    written += chunk.toString();
    return true;
  });
  try {
    delete process.env.PI_TOKEN_AUDIT;
    maybeLogTokenAudit({ messages: [{ role: "user", content: "secret prompt", timestamp: 1 }] }, []);
    assert.equal(written, "");
    process.env.PI_TOKEN_AUDIT = "1";
    maybeLogTokenAudit({ systemPrompt: "hidden system", messages: [{ role: "user", content: "secret prompt", timestamp: 1 }] }, []);
    assert.match(written, /"type":"token_audit"/);
    assert.doesNotMatch(written, /secret prompt/);
    assert.doesNotMatch(written, /hidden system/);
  } finally {
    process.stderr.write = originalWrite;
    if (original === void 0) delete process.env.PI_TOKEN_AUDIT;
    else process.env.PI_TOKEN_AUDIT = original;
  }
});
test("provider payload audit summarizes post-hook payload without raw content", () => {
  const payload = {
    system: "secret system content",
    tools: [{
      type: "function",
      function: {
        name: "read",
        description: "secret tool description",
        parameters: { type: "object" }
      }
    }],
    messages: [
      { role: "user", content: "secret user content" },
      { role: "assistant", content: [{ type: "text", text: "secret assistant content" }] }
    ]
  };
  const summary = buildProviderPayloadAuditSummary(payload);
  assert.equal(summary.messageCount, 2);
  assert.equal(summary.toolCount, 1);
  assert.ok(summary.payloadChars > 0);
  assert.ok(summary.toolSchemaChars > 0);
  assert.deepEqual(summary.largestTools.map((tool) => tool.name), ["read"]);
  assert.equal(JSON.stringify(summary).includes("secret"), false);
});
test("provider payload audit recognizes Gemini and Bedrock payload shapes", () => {
  const gemini = buildProviderPayloadAuditSummary({
    contents: [{ role: "user", parts: [{ text: "hidden gemini prompt" }] }],
    config: {
      tools: [{
        functionDeclarations: [
          { name: "gsd_exec", description: "hidden declaration", parameters: { type: "object" } }
        ]
      }]
    }
  });
  const bedrock = buildProviderPayloadAuditSummary({
    messages: [{ role: "user", content: [{ text: "hidden bedrock prompt" }] }],
    toolConfig: {
      tools: [
        { toolSpec: { name: "gsd_resume", description: "hidden tool", inputSchema: { json: {} } } }
      ]
    }
  });
  assert.equal(gemini.messageCount, 1);
  assert.equal(gemini.toolCount, 1);
  assert.deepEqual(gemini.largestTools.map((tool) => tool.name), ["gsd_exec"]);
  assert.equal(JSON.stringify(gemini).includes("hidden"), false);
  assert.equal(bedrock.messageCount, 1);
  assert.equal(bedrock.toolCount, 1);
  assert.deepEqual(bedrock.largestTools.map((tool) => tool.name), ["gsd_resume"]);
  assert.equal(JSON.stringify(bedrock).includes("hidden"), false);
});
test("provider payload audit logging is metadata-only", () => {
  const original = process.env.PI_TOKEN_AUDIT;
  const originalWrite = process.stderr.write;
  let written = "";
  process.env.PI_TOKEN_AUDIT = "1";
  process.stderr.write = ((chunk) => {
    written += chunk.toString();
    return true;
  });
  try {
    maybeLogProviderPayloadAudit({
      messages: [{ role: "user", content: "raw prompt text must not log" }],
      tools: [{ name: "bash", description: "raw tool description must not log" }]
    }, "after");
    assert.match(written, /"type":"token_audit_provider_payload"/);
    assert.match(written, /"phase":"after"/);
    assert.doesNotMatch(written, /raw prompt text/);
    assert.doesNotMatch(written, /raw tool description/);
  } finally {
    process.stderr.write = originalWrite;
    if (original === void 0) delete process.env.PI_TOKEN_AUDIT;
    else process.env.PI_TOKEN_AUDIT = original;
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWdlbnQtY29yZS9zcmMvdG9rZW4tYXVkaXQudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFRlc3RzIGZvciBwcm92aWRlci1ib3VuZGFyeSB0b2tlbiBwYXlsb2FkIGF1ZGl0IGhlbHBlcnMuXG5cbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IHsgVHlwZSB9IGZyb20gXCJAc2luY2xhaXIvdHlwZWJveFwiO1xuaW1wb3J0IHR5cGUgeyBDb250ZXh0IH0gZnJvbSBcIkBnc2QvcGktYWlcIjtcbmltcG9ydCB0eXBlIHsgQWdlbnRNZXNzYWdlIH0gZnJvbSBcIi4vdHlwZXMuanNcIjtcbmltcG9ydCB7XG5cdGJ1aWxkUHJvdmlkZXJQYXlsb2FkQXVkaXRTdW1tYXJ5LFxuXHRidWlsZFRva2VuQXVkaXRTdW1tYXJ5LFxuXHRtYXliZUxvZ1Byb3ZpZGVyUGF5bG9hZEF1ZGl0LFxuXHRtYXliZUxvZ1Rva2VuQXVkaXQsXG59IGZyb20gXCIuL3Rva2VuLWF1ZGl0LmpzXCI7XG5cbnRlc3QoXCJidWlsZFRva2VuQXVkaXRTdW1tYXJ5IHJlcG9ydHMgcGF5bG9hZCBzZWN0aW9uIHNpemVzIHdpdGhvdXQgY29udGVudCBmaWVsZHNcIiwgKCkgPT4ge1xuXHRjb25zdCBjb250ZXh0OiBDb250ZXh0ID0ge1xuXHRcdHN5c3RlbVByb21wdDogXCJzeXN0ZW0gcHJvbXB0XCIsXG5cdFx0dG9vbHM6IFtcblx0XHRcdHtcblx0XHRcdFx0bmFtZTogXCJyZWFkXCIsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiBcIlJlYWQgYSBmaWxlXCIsXG5cdFx0XHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHsgcGF0aDogVHlwZS5TdHJpbmcoKSB9KSxcblx0XHRcdH0sXG5cdFx0XHR7XG5cdFx0XHRcdG5hbWU6IFwibGFyZ2VfdG9vbFwiLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogXCJMYXJnZSBzY2hlbWFcIi5yZXBlYXQoMjApLFxuXHRcdFx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7IHZhbHVlOiBUeXBlLlN0cmluZygpIH0pLFxuXHRcdFx0fSxcblx0XHRdLFxuXHRcdG1lc3NhZ2VzOiBbXG5cdFx0XHR7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJoZWxsb1wiIH1dLCB0aW1lc3RhbXA6IDEgfSxcblx0XHRcdHtcblx0XHRcdFx0cm9sZTogXCJ0b29sUmVzdWx0XCIsXG5cdFx0XHRcdHRvb2xDYWxsSWQ6IFwiY2FsbC0xXCIsXG5cdFx0XHRcdHRvb2xOYW1lOiBcInJlYWRcIixcblx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwidG9vbCBvdXRwdXRcIiB9XSxcblx0XHRcdFx0aXNFcnJvcjogZmFsc2UsXG5cdFx0XHRcdHRpbWVzdGFtcDogMixcblx0XHRcdH0sXG5cdFx0XHR7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBbeyB0eXBlOiBcImltYWdlXCIsIGRhdGE6IFwiYWJjMTIzXCIsIG1pbWVUeXBlOiBcImltYWdlL3BuZ1wiIH1dLCB0aW1lc3RhbXA6IDMgfSxcblx0XHRdLFxuXHR9O1xuXHRjb25zdCBzb3VyY2VNZXNzYWdlcyA9IFtcblx0XHQuLi5jb250ZXh0Lm1lc3NhZ2VzLFxuXHRcdHtcblx0XHRcdHJvbGU6IFwiY3VzdG9tXCIsXG5cdFx0XHRjdXN0b21UeXBlOiBcImdzZC1tZW1vcnlcIixcblx0XHRcdGNvbnRlbnQ6IFwibWVtb3J5IGJsb2NrXCIsXG5cdFx0XHRkaXNwbGF5OiBmYWxzZSxcblx0XHRcdHRpbWVzdGFtcDogNCxcblx0XHR9IGFzIEFnZW50TWVzc2FnZSxcblx0XTtcblxuXHRjb25zdCBzdW1tYXJ5ID0gYnVpbGRUb2tlbkF1ZGl0U3VtbWFyeShjb250ZXh0LCBzb3VyY2VNZXNzYWdlcyk7XG5cblx0YXNzZXJ0LmVxdWFsKHN1bW1hcnkuc3lzdGVtQ2hhcnMsIFwic3lzdGVtIHByb21wdFwiLmxlbmd0aCk7XG5cdGFzc2VydC5lcXVhbChzdW1tYXJ5LnRvb2xDb3VudCwgMik7XG5cdGFzc2VydC5lcXVhbChzdW1tYXJ5Lm1lc3NhZ2VDb3VudCwgMyk7XG5cdGFzc2VydC5lcXVhbChzdW1tYXJ5LnRvb2xSZXN1bHRDaGFycywgXCJ0b29sIG91dHB1dFwiLmxlbmd0aCk7XG5cdGFzc2VydC5lcXVhbChzdW1tYXJ5LmltYWdlQ291bnQsIDEpO1xuXHRhc3NlcnQub2soc3VtbWFyeS50b29sU2NoZW1hQ2hhcnMgPiAwKTtcblx0YXNzZXJ0Lm9rKHN1bW1hcnkuY3VzdG9tTWVzc2FnZUNoYXJzID4gMCk7XG5cdGFzc2VydC5vayhzdW1tYXJ5LmVzdGltYXRlZElucHV0VG9rZW5zID4gMCk7XG5cdGFzc2VydC5kZWVwRXF1YWwoXG5cdFx0c3VtbWFyeS5sYXJnZXN0TWVzc2FnZXMubWFwKChtZXNzYWdlKSA9PiBPYmplY3Qua2V5cyhtZXNzYWdlKS5zb3J0KCkpLFxuXHRcdHN1bW1hcnkubGFyZ2VzdE1lc3NhZ2VzLm1hcCgoKSA9PiBbXCJjaGFyc1wiLCBcImluZGV4XCIsIFwicm9sZVwiLCBcInR5cGVcIl0pLFxuXHQpO1xuXHRhc3NlcnQuZXF1YWwoc3VtbWFyeS5sYXJnZXN0VG9vbHNbMF0ubmFtZSwgXCJsYXJnZV90b29sXCIpO1xuXHRhc3NlcnQuZGVlcEVxdWFsKFxuXHRcdHN1bW1hcnkubGFyZ2VzdFRvb2xzLm1hcCgodG9vbCkgPT4gT2JqZWN0LmtleXModG9vbCkuc29ydCgpKSxcblx0XHRzdW1tYXJ5Lmxhcmdlc3RUb29scy5tYXAoKCkgPT4gW1wiY2hhcnNcIiwgXCJuYW1lXCJdKSxcblx0KTtcblx0YXNzZXJ0LmRlZXBFcXVhbChzdW1tYXJ5Lmxhcmdlc3RDdXN0b21NZXNzYWdlcywgW1xuXHRcdHsgaW5kZXg6IDMsIHJvbGU6IFwiY3VzdG9tXCIsIGN1c3RvbVR5cGU6IFwiZ3NkLW1lbW9yeVwiLCBjaGFyczogc3VtbWFyeS5sYXJnZXN0Q3VzdG9tTWVzc2FnZXNbMF0uY2hhcnMgfSxcblx0XSk7XG5cdGFzc2VydC5vayghSlNPTi5zdHJpbmdpZnkoc3VtbWFyeSkuaW5jbHVkZXMoXCJ0b29sIG91dHB1dFwiKSk7XG5cdGFzc2VydC5vayghSlNPTi5zdHJpbmdpZnkoc3VtbWFyeSkuaW5jbHVkZXMoXCJtZW1vcnkgYmxvY2tcIikpO1xufSk7XG5cbnRlc3QoXCJtYXliZUxvZ1Rva2VuQXVkaXQgaXMgb3B0LWluIGFuZCBlbWl0cyBtZXRhZGF0YSBvbmx5XCIsICgpID0+IHtcblx0Y29uc3Qgb3JpZ2luYWwgPSBwcm9jZXNzLmVudi5QSV9UT0tFTl9BVURJVDtcblx0Y29uc3Qgb3JpZ2luYWxXcml0ZSA9IHByb2Nlc3Muc3RkZXJyLndyaXRlO1xuXHRsZXQgd3JpdHRlbiA9IFwiXCI7XG5cdHByb2Nlc3Muc3RkZXJyLndyaXRlID0gKChjaHVuazogc3RyaW5nIHwgVWludDhBcnJheSkgPT4ge1xuXHRcdHdyaXR0ZW4gKz0gY2h1bmsudG9TdHJpbmcoKTtcblx0XHRyZXR1cm4gdHJ1ZTtcblx0fSkgYXMgdHlwZW9mIHByb2Nlc3Muc3RkZXJyLndyaXRlO1xuXG5cdHRyeSB7XG5cdFx0ZGVsZXRlIHByb2Nlc3MuZW52LlBJX1RPS0VOX0FVRElUO1xuXHRcdG1heWJlTG9nVG9rZW5BdWRpdCh7IG1lc3NhZ2VzOiBbeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogXCJzZWNyZXQgcHJvbXB0XCIsIHRpbWVzdGFtcDogMSB9XSB9LCBbXSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHdyaXR0ZW4sIFwiXCIpO1xuXG5cdFx0cHJvY2Vzcy5lbnYuUElfVE9LRU5fQVVESVQgPSBcIjFcIjtcblx0XHRtYXliZUxvZ1Rva2VuQXVkaXQoeyBzeXN0ZW1Qcm9tcHQ6IFwiaGlkZGVuIHN5c3RlbVwiLCBtZXNzYWdlczogW3sgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFwic2VjcmV0IHByb21wdFwiLCB0aW1lc3RhbXA6IDEgfV0gfSwgW10pO1xuXHRcdGFzc2VydC5tYXRjaCh3cml0dGVuLCAvXCJ0eXBlXCI6XCJ0b2tlbl9hdWRpdFwiLyk7XG5cdFx0YXNzZXJ0LmRvZXNOb3RNYXRjaCh3cml0dGVuLCAvc2VjcmV0IHByb21wdC8pO1xuXHRcdGFzc2VydC5kb2VzTm90TWF0Y2god3JpdHRlbiwgL2hpZGRlbiBzeXN0ZW0vKTtcblx0fSBmaW5hbGx5IHtcblx0XHRwcm9jZXNzLnN0ZGVyci53cml0ZSA9IG9yaWdpbmFsV3JpdGU7XG5cdFx0aWYgKG9yaWdpbmFsID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudi5QSV9UT0tFTl9BVURJVDtcblx0XHRlbHNlIHByb2Nlc3MuZW52LlBJX1RPS0VOX0FVRElUID0gb3JpZ2luYWw7XG5cdH1cbn0pO1xuXG50ZXN0KFwicHJvdmlkZXIgcGF5bG9hZCBhdWRpdCBzdW1tYXJpemVzIHBvc3QtaG9vayBwYXlsb2FkIHdpdGhvdXQgcmF3IGNvbnRlbnRcIiwgKCkgPT4ge1xuXHRjb25zdCBwYXlsb2FkID0ge1xuXHRcdHN5c3RlbTogXCJzZWNyZXQgc3lzdGVtIGNvbnRlbnRcIixcblx0XHR0b29sczogW3tcblx0XHRcdHR5cGU6IFwiZnVuY3Rpb25cIixcblx0XHRcdGZ1bmN0aW9uOiB7XG5cdFx0XHRcdG5hbWU6IFwicmVhZFwiLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogXCJzZWNyZXQgdG9vbCBkZXNjcmlwdGlvblwiLFxuXHRcdFx0XHRwYXJhbWV0ZXJzOiB7IHR5cGU6IFwib2JqZWN0XCIgfSxcblx0XHRcdH0sXG5cdFx0fV0sXG5cdFx0bWVzc2FnZXM6IFtcblx0XHRcdHsgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFwic2VjcmV0IHVzZXIgY29udGVudFwiIH0sXG5cdFx0XHR7IHJvbGU6IFwiYXNzaXN0YW50XCIsIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcInNlY3JldCBhc3Npc3RhbnQgY29udGVudFwiIH1dIH0sXG5cdFx0XSxcblx0fTtcblxuXHRjb25zdCBzdW1tYXJ5ID0gYnVpbGRQcm92aWRlclBheWxvYWRBdWRpdFN1bW1hcnkocGF5bG9hZCk7XG5cblx0YXNzZXJ0LmVxdWFsKHN1bW1hcnkubWVzc2FnZUNvdW50LCAyKTtcblx0YXNzZXJ0LmVxdWFsKHN1bW1hcnkudG9vbENvdW50LCAxKTtcblx0YXNzZXJ0Lm9rKHN1bW1hcnkucGF5bG9hZENoYXJzID4gMCk7XG5cdGFzc2VydC5vayhzdW1tYXJ5LnRvb2xTY2hlbWFDaGFycyA+IDApO1xuXHRhc3NlcnQuZGVlcEVxdWFsKHN1bW1hcnkubGFyZ2VzdFRvb2xzLm1hcCgodG9vbCkgPT4gdG9vbC5uYW1lKSwgW1wicmVhZFwiXSk7XG5cdGFzc2VydC5lcXVhbChKU09OLnN0cmluZ2lmeShzdW1tYXJ5KS5pbmNsdWRlcyhcInNlY3JldFwiKSwgZmFsc2UpO1xufSk7XG5cbnRlc3QoXCJwcm92aWRlciBwYXlsb2FkIGF1ZGl0IHJlY29nbml6ZXMgR2VtaW5pIGFuZCBCZWRyb2NrIHBheWxvYWQgc2hhcGVzXCIsICgpID0+IHtcblx0Y29uc3QgZ2VtaW5pID0gYnVpbGRQcm92aWRlclBheWxvYWRBdWRpdFN1bW1hcnkoe1xuXHRcdGNvbnRlbnRzOiBbeyByb2xlOiBcInVzZXJcIiwgcGFydHM6IFt7IHRleHQ6IFwiaGlkZGVuIGdlbWluaSBwcm9tcHRcIiB9XSB9XSxcblx0XHRjb25maWc6IHtcblx0XHRcdHRvb2xzOiBbe1xuXHRcdFx0XHRmdW5jdGlvbkRlY2xhcmF0aW9uczogW1xuXHRcdFx0XHRcdHsgbmFtZTogXCJnc2RfZXhlY1wiLCBkZXNjcmlwdGlvbjogXCJoaWRkZW4gZGVjbGFyYXRpb25cIiwgcGFyYW1ldGVyczogeyB0eXBlOiBcIm9iamVjdFwiIH0gfSxcblx0XHRcdFx0XSxcblx0XHRcdH1dLFxuXHRcdH0sXG5cdH0pO1xuXHRjb25zdCBiZWRyb2NrID0gYnVpbGRQcm92aWRlclBheWxvYWRBdWRpdFN1bW1hcnkoe1xuXHRcdG1lc3NhZ2VzOiBbeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogW3sgdGV4dDogXCJoaWRkZW4gYmVkcm9jayBwcm9tcHRcIiB9XSB9XSxcblx0XHR0b29sQ29uZmlnOiB7XG5cdFx0XHR0b29sczogW1xuXHRcdFx0XHR7IHRvb2xTcGVjOiB7IG5hbWU6IFwiZ3NkX3Jlc3VtZVwiLCBkZXNjcmlwdGlvbjogXCJoaWRkZW4gdG9vbFwiLCBpbnB1dFNjaGVtYTogeyBqc29uOiB7fSB9IH0gfSxcblx0XHRcdF0sXG5cdFx0fSxcblx0fSk7XG5cblx0YXNzZXJ0LmVxdWFsKGdlbWluaS5tZXNzYWdlQ291bnQsIDEpO1xuXHRhc3NlcnQuZXF1YWwoZ2VtaW5pLnRvb2xDb3VudCwgMSk7XG5cdGFzc2VydC5kZWVwRXF1YWwoZ2VtaW5pLmxhcmdlc3RUb29scy5tYXAoKHRvb2wpID0+IHRvb2wubmFtZSksIFtcImdzZF9leGVjXCJdKTtcblx0YXNzZXJ0LmVxdWFsKEpTT04uc3RyaW5naWZ5KGdlbWluaSkuaW5jbHVkZXMoXCJoaWRkZW5cIiksIGZhbHNlKTtcblxuXHRhc3NlcnQuZXF1YWwoYmVkcm9jay5tZXNzYWdlQ291bnQsIDEpO1xuXHRhc3NlcnQuZXF1YWwoYmVkcm9jay50b29sQ291bnQsIDEpO1xuXHRhc3NlcnQuZGVlcEVxdWFsKGJlZHJvY2subGFyZ2VzdFRvb2xzLm1hcCgodG9vbCkgPT4gdG9vbC5uYW1lKSwgW1wiZ3NkX3Jlc3VtZVwiXSk7XG5cdGFzc2VydC5lcXVhbChKU09OLnN0cmluZ2lmeShiZWRyb2NrKS5pbmNsdWRlcyhcImhpZGRlblwiKSwgZmFsc2UpO1xufSk7XG5cbnRlc3QoXCJwcm92aWRlciBwYXlsb2FkIGF1ZGl0IGxvZ2dpbmcgaXMgbWV0YWRhdGEtb25seVwiLCAoKSA9PiB7XG5cdGNvbnN0IG9yaWdpbmFsID0gcHJvY2Vzcy5lbnYuUElfVE9LRU5fQVVESVQ7XG5cdGNvbnN0IG9yaWdpbmFsV3JpdGUgPSBwcm9jZXNzLnN0ZGVyci53cml0ZTtcblx0bGV0IHdyaXR0ZW4gPSBcIlwiO1xuXHRwcm9jZXNzLmVudi5QSV9UT0tFTl9BVURJVCA9IFwiMVwiO1xuXHRwcm9jZXNzLnN0ZGVyci53cml0ZSA9ICgoY2h1bms6IHN0cmluZyB8IFVpbnQ4QXJyYXkpID0+IHtcblx0XHR3cml0dGVuICs9IGNodW5rLnRvU3RyaW5nKCk7XG5cdFx0cmV0dXJuIHRydWU7XG5cdH0pIGFzIHR5cGVvZiBwcm9jZXNzLnN0ZGVyci53cml0ZTtcblxuXHR0cnkge1xuXHRcdG1heWJlTG9nUHJvdmlkZXJQYXlsb2FkQXVkaXQoe1xuXHRcdFx0bWVzc2FnZXM6IFt7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBcInJhdyBwcm9tcHQgdGV4dCBtdXN0IG5vdCBsb2dcIiB9XSxcblx0XHRcdHRvb2xzOiBbeyBuYW1lOiBcImJhc2hcIiwgZGVzY3JpcHRpb246IFwicmF3IHRvb2wgZGVzY3JpcHRpb24gbXVzdCBub3QgbG9nXCIgfV0sXG5cdFx0fSwgXCJhZnRlclwiKTtcblx0XHRhc3NlcnQubWF0Y2god3JpdHRlbiwgL1widHlwZVwiOlwidG9rZW5fYXVkaXRfcHJvdmlkZXJfcGF5bG9hZFwiLyk7XG5cdFx0YXNzZXJ0Lm1hdGNoKHdyaXR0ZW4sIC9cInBoYXNlXCI6XCJhZnRlclwiLyk7XG5cdFx0YXNzZXJ0LmRvZXNOb3RNYXRjaCh3cml0dGVuLCAvcmF3IHByb21wdCB0ZXh0Lyk7XG5cdFx0YXNzZXJ0LmRvZXNOb3RNYXRjaCh3cml0dGVuLCAvcmF3IHRvb2wgZGVzY3JpcHRpb24vKTtcblx0fSBmaW5hbGx5IHtcblx0XHRwcm9jZXNzLnN0ZGVyci53cml0ZSA9IG9yaWdpbmFsV3JpdGU7XG5cdFx0aWYgKG9yaWdpbmFsID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudi5QSV9UT0tFTl9BVURJVDtcblx0XHRlbHNlIHByb2Nlc3MuZW52LlBJX1RPS0VOX0FVRElUID0gb3JpZ2luYWw7XG5cdH1cbn0pO1xuIl0sCiAgIm1h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
