import assert from "node:assert/strict";
import test from "node:test";
import { serializeConversation, truncateForSummary } from "./compaction/index.js";
test("serializeConversation uses narrative role markers instead of chat-style delimiters (#4054)", () => {
  const messages = [
    { role: "user", content: "Please refactor the parser." },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I should inspect the parser entry points first." },
        { type: "text", text: "I'll start with the parser entry points." },
        { type: "toolCall", id: "tool-1", name: "Read", arguments: { path: "src/parser.ts" } }
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "stop",
      timestamp: Date.now()
    },
    {
      role: "toolResult",
      content: [{ type: "text", text: "parser contents" }],
      toolName: "Read",
      toolCallId: "tool-1"
    }
  ];
  const serialized = serializeConversation(messages);
  assert.match(serialized, /\*\*User said:\*\* Please refactor the parser\./);
  assert.match(serialized, /\*\*Assistant thinking:\*\* I should inspect the parser entry points first\./);
  assert.match(serialized, /\*\*Assistant responded:\*\* I'll start with the parser entry points\./);
  assert.match(serialized, /\*\*Assistant tool calls:\*\* Read\(path="src\/parser\.ts"\)/);
  assert.match(serialized, /\*\*Tool result:\*\* parser contents/);
  assert.ok(!serialized.includes("[User]:"), "chat-style [User]: markers should not remain");
  assert.ok(!serialized.includes("[Assistant]:"), "chat-style [Assistant]: markers should not remain");
  assert.ok(!serialized.includes("[Tool result]:"), "chat-style [Tool result]: markers should not remain");
});
test("(#4665) truncateForSummary keeps both head AND tail \u2014 tail carries result/verdict text", () => {
  const head = "setup log line A\n".repeat(500);
  const tail = "RESULT: 258 passed, 0 failed. exit_code=0 commit=abc1234";
  const input = head + tail;
  const out = truncateForSummary(input, 2e3);
  assert.ok(out.length < input.length, "must truncate when over cap");
  assert.ok(out.includes("setup log line A"), "head content preserved");
  assert.ok(out.includes("RESULT: 258 passed"), "tail content preserved (issue #4665)");
  assert.match(out, /more characters truncated/, "emits an elision marker");
});
test("(#4665) truncateForSummary is a no-op when input is within the cap", () => {
  const input = "short enough";
  assert.equal(truncateForSummary(input, 2e3), input);
});
test("(#4665) serializeConversation caps large user content, not just tool results", () => {
  const hugeUserText = "U".repeat(1e5);
  const hugeAssistantText = "A".repeat(1e5);
  const hugeToolResult = "T".repeat(1e5);
  const messages = [
    { role: "user", content: hugeUserText },
    {
      role: "assistant",
      content: [{ type: "text", text: hugeAssistantText }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "stop",
      timestamp: Date.now()
    },
    {
      role: "toolResult",
      content: [{ type: "text", text: hugeToolResult }],
      toolName: "Bash",
      toolCallId: "tool-huge"
    }
  ];
  const serialized = serializeConversation(messages);
  assert.ok(
    serialized.length < 1e4,
    `serialized output should be small after capping all blocks, got ${serialized.length} chars`
  );
  assert.match(serialized, /more characters truncated/, "truncation marker present");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2NvbXBhY3Rpb24tdXRpbHMudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5cbmltcG9ydCB0eXBlIHsgTWVzc2FnZSB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5cbmltcG9ydCB7IHNlcmlhbGl6ZUNvbnZlcnNhdGlvbiwgdHJ1bmNhdGVGb3JTdW1tYXJ5IH0gZnJvbSBcIi4vY29tcGFjdGlvbi9pbmRleC5qc1wiO1xuXG50ZXN0KFwic2VyaWFsaXplQ29udmVyc2F0aW9uIHVzZXMgbmFycmF0aXZlIHJvbGUgbWFya2VycyBpbnN0ZWFkIG9mIGNoYXQtc3R5bGUgZGVsaW1pdGVycyAoIzQwNTQpXCIsICgpID0+IHtcblx0Y29uc3QgbWVzc2FnZXM6IE1lc3NhZ2VbXSA9IFtcblx0XHR7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBcIlBsZWFzZSByZWZhY3RvciB0aGUgcGFyc2VyLlwiIH0gYXMgTWVzc2FnZSxcblx0XHR7XG5cdFx0XHRyb2xlOiBcImFzc2lzdGFudFwiLFxuXHRcdFx0Y29udGVudDogW1xuXHRcdFx0XHR7IHR5cGU6IFwidGhpbmtpbmdcIiwgdGhpbmtpbmc6IFwiSSBzaG91bGQgaW5zcGVjdCB0aGUgcGFyc2VyIGVudHJ5IHBvaW50cyBmaXJzdC5cIiB9LFxuXHRcdFx0XHR7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkknbGwgc3RhcnQgd2l0aCB0aGUgcGFyc2VyIGVudHJ5IHBvaW50cy5cIiB9LFxuXHRcdFx0XHR7IHR5cGU6IFwidG9vbENhbGxcIiwgaWQ6IFwidG9vbC0xXCIsIG5hbWU6IFwiUmVhZFwiLCBhcmd1bWVudHM6IHsgcGF0aDogXCJzcmMvcGFyc2VyLnRzXCIgfSB9LFxuXHRcdFx0XSxcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLFxuXHRcdFx0bW9kZWw6IFwiY2xhdWRlLXNvbm5ldC00LTZcIixcblx0XHRcdHVzYWdlOiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdFx0dG90YWxUb2tlbnM6IDAsXG5cdFx0XHRcdGNvc3Q6IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCB0b3RhbDogMCB9LFxuXHRcdFx0fSxcblx0XHRcdHN0b3BSZWFzb246IFwic3RvcFwiLFxuXHRcdFx0dGltZXN0YW1wOiBEYXRlLm5vdygpLFxuXHRcdH0gYXMgTWVzc2FnZSxcblx0XHR7XG5cdFx0XHRyb2xlOiBcInRvb2xSZXN1bHRcIixcblx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcInBhcnNlciBjb250ZW50c1wiIH1dLFxuXHRcdFx0dG9vbE5hbWU6IFwiUmVhZFwiLFxuXHRcdFx0dG9vbENhbGxJZDogXCJ0b29sLTFcIixcblx0XHR9IGFzIE1lc3NhZ2UsXG5cdF07XG5cblx0Y29uc3Qgc2VyaWFsaXplZCA9IHNlcmlhbGl6ZUNvbnZlcnNhdGlvbihtZXNzYWdlcyk7XG5cblx0YXNzZXJ0Lm1hdGNoKHNlcmlhbGl6ZWQsIC9cXCpcXCpVc2VyIHNhaWQ6XFwqXFwqIFBsZWFzZSByZWZhY3RvciB0aGUgcGFyc2VyXFwuLyk7XG5cdGFzc2VydC5tYXRjaChzZXJpYWxpemVkLCAvXFwqXFwqQXNzaXN0YW50IHRoaW5raW5nOlxcKlxcKiBJIHNob3VsZCBpbnNwZWN0IHRoZSBwYXJzZXIgZW50cnkgcG9pbnRzIGZpcnN0XFwuLyk7XG5cdGFzc2VydC5tYXRjaChzZXJpYWxpemVkLCAvXFwqXFwqQXNzaXN0YW50IHJlc3BvbmRlZDpcXCpcXCogSSdsbCBzdGFydCB3aXRoIHRoZSBwYXJzZXIgZW50cnkgcG9pbnRzXFwuLyk7XG5cdGFzc2VydC5tYXRjaChzZXJpYWxpemVkLCAvXFwqXFwqQXNzaXN0YW50IHRvb2wgY2FsbHM6XFwqXFwqIFJlYWRcXChwYXRoPVwic3JjXFwvcGFyc2VyXFwudHNcIlxcKS8pO1xuXHRhc3NlcnQubWF0Y2goc2VyaWFsaXplZCwgL1xcKlxcKlRvb2wgcmVzdWx0OlxcKlxcKiBwYXJzZXIgY29udGVudHMvKTtcblx0YXNzZXJ0Lm9rKCFzZXJpYWxpemVkLmluY2x1ZGVzKFwiW1VzZXJdOlwiKSwgXCJjaGF0LXN0eWxlIFtVc2VyXTogbWFya2VycyBzaG91bGQgbm90IHJlbWFpblwiKTtcblx0YXNzZXJ0Lm9rKCFzZXJpYWxpemVkLmluY2x1ZGVzKFwiW0Fzc2lzdGFudF06XCIpLCBcImNoYXQtc3R5bGUgW0Fzc2lzdGFudF06IG1hcmtlcnMgc2hvdWxkIG5vdCByZW1haW5cIik7XG5cdGFzc2VydC5vayghc2VyaWFsaXplZC5pbmNsdWRlcyhcIltUb29sIHJlc3VsdF06XCIpLCBcImNoYXQtc3R5bGUgW1Rvb2wgcmVzdWx0XTogbWFya2VycyBzaG91bGQgbm90IHJlbWFpblwiKTtcbn0pO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vICM0NjY1IHJlZ3Jlc3Npb246IGhlYWQrdGFpbCB0cnVuY2F0aW9uIGtlZXBzIHZlcmRpY3RzL3Jlc3VsdHNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG50ZXN0KFwiKCM0NjY1KSB0cnVuY2F0ZUZvclN1bW1hcnkga2VlcHMgYm90aCBoZWFkIEFORCB0YWlsIFx1MjAxNCB0YWlsIGNhcnJpZXMgcmVzdWx0L3ZlcmRpY3QgdGV4dFwiLCAoKSA9PiB7XG5cdC8vIENvbnN0cnVjdCBhIDEwSy1jaGFyIGZpeHR1cmUgd2hlcmUgdGhlIEhFQUQgaXMgXCJzZXR1cCBub2lzZVwiIGFuZCB0aGUgVEFJTFxuXHQvLyBjb250YWlucyBhIHJlc3VsdCBsaW5lLiBUaGUgb2xkIGhlYWQtb25seSB0cnVuY2F0aW9uIHdvdWxkIGRyb3AgdGhlIHRhaWxcblx0Ly8gYW5kIGxvc2UgdGhlIHJlc3VsdC4gVGhlIGZpeCBwcmVzZXJ2ZXMgYm90aC5cblx0Y29uc3QgaGVhZCA9IFwic2V0dXAgbG9nIGxpbmUgQVxcblwiLnJlcGVhdCg1MDApOyAvLyB+ODUwMCBjaGFycyBvZiBzZXR1cFxuXHRjb25zdCB0YWlsID0gXCJSRVNVTFQ6IDI1OCBwYXNzZWQsIDAgZmFpbGVkLiBleGl0X2NvZGU9MCBjb21taXQ9YWJjMTIzNFwiO1xuXHRjb25zdCBpbnB1dCA9IGhlYWQgKyB0YWlsO1xuXG5cdGNvbnN0IG91dCA9IHRydW5jYXRlRm9yU3VtbWFyeShpbnB1dCwgMl8wMDApO1xuXG5cdGFzc2VydC5vayhvdXQubGVuZ3RoIDwgaW5wdXQubGVuZ3RoLCBcIm11c3QgdHJ1bmNhdGUgd2hlbiBvdmVyIGNhcFwiKTtcblx0YXNzZXJ0Lm9rKG91dC5pbmNsdWRlcyhcInNldHVwIGxvZyBsaW5lIEFcIiksIFwiaGVhZCBjb250ZW50IHByZXNlcnZlZFwiKTtcblx0YXNzZXJ0Lm9rKG91dC5pbmNsdWRlcyhcIlJFU1VMVDogMjU4IHBhc3NlZFwiKSwgXCJ0YWlsIGNvbnRlbnQgcHJlc2VydmVkIChpc3N1ZSAjNDY2NSlcIik7XG5cdGFzc2VydC5tYXRjaChvdXQsIC9tb3JlIGNoYXJhY3RlcnMgdHJ1bmNhdGVkLywgXCJlbWl0cyBhbiBlbGlzaW9uIG1hcmtlclwiKTtcbn0pO1xuXG50ZXN0KFwiKCM0NjY1KSB0cnVuY2F0ZUZvclN1bW1hcnkgaXMgYSBuby1vcCB3aGVuIGlucHV0IGlzIHdpdGhpbiB0aGUgY2FwXCIsICgpID0+IHtcblx0Y29uc3QgaW5wdXQgPSBcInNob3J0IGVub3VnaFwiO1xuXHRhc3NlcnQuZXF1YWwodHJ1bmNhdGVGb3JTdW1tYXJ5KGlucHV0LCAyXzAwMCksIGlucHV0KTtcbn0pO1xuXG50ZXN0KFwiKCM0NjY1KSBzZXJpYWxpemVDb252ZXJzYXRpb24gY2FwcyBsYXJnZSB1c2VyIGNvbnRlbnQsIG5vdCBqdXN0IHRvb2wgcmVzdWx0c1wiLCAoKSA9PiB7XG5cdC8vIFByZS1maXgsIG9ubHkgdG9vbFJlc3VsdCBibG9ja3Mgd2VyZSBjYXBwZWQuIEEgbGFyZ2UgdXNlciBwYXN0ZSBjb3VsZFxuXHQvLyBzdGlsbCBibG93IG91dCB0aGUgY2h1bmtlcidzIHRva2VuIG1hdGggYW5kIHRoZSBMTE0ncyBpbnB1dCBidWRnZXQuXG5cdGNvbnN0IGh1Z2VVc2VyVGV4dCA9IFwiVVwiLnJlcGVhdCgxMDBfMDAwKTtcblx0Y29uc3QgaHVnZUFzc2lzdGFudFRleHQgPSBcIkFcIi5yZXBlYXQoMTAwXzAwMCk7XG5cdGNvbnN0IGh1Z2VUb29sUmVzdWx0ID0gXCJUXCIucmVwZWF0KDEwMF8wMDApO1xuXG5cdGNvbnN0IG1lc3NhZ2VzOiBNZXNzYWdlW10gPSBbXG5cdFx0eyByb2xlOiBcInVzZXJcIiwgY29udGVudDogaHVnZVVzZXJUZXh0IH0gYXMgTWVzc2FnZSxcblx0XHR7XG5cdFx0XHRyb2xlOiBcImFzc2lzdGFudFwiLFxuXHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGh1Z2VBc3Npc3RhbnRUZXh0IH1dLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW50aHJvcGljXCIsXG5cdFx0XHRtb2RlbDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLFxuXHRcdFx0dXNhZ2U6IHtcblx0XHRcdFx0aW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCB0b3RhbFRva2VuczogMCxcblx0XHRcdFx0Y29zdDogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIHRvdGFsOiAwIH0sXG5cdFx0XHR9LFxuXHRcdFx0c3RvcFJlYXNvbjogXCJzdG9wXCIsXG5cdFx0XHR0aW1lc3RhbXA6IERhdGUubm93KCksXG5cdFx0fSBhcyBNZXNzYWdlLFxuXHRcdHtcblx0XHRcdHJvbGU6IFwidG9vbFJlc3VsdFwiLFxuXHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGh1Z2VUb29sUmVzdWx0IH1dLFxuXHRcdFx0dG9vbE5hbWU6IFwiQmFzaFwiLFxuXHRcdFx0dG9vbENhbGxJZDogXCJ0b29sLWh1Z2VcIixcblx0XHR9IGFzIE1lc3NhZ2UsXG5cdF07XG5cblx0Y29uc3Qgc2VyaWFsaXplZCA9IHNlcmlhbGl6ZUNvbnZlcnNhdGlvbihtZXNzYWdlcyk7XG5cblx0Ly8gRWFjaCBibG9jayBpcyB0cnVuY2F0ZWQgaW5kZXBlbmRlbnRseSB0byBUT09MX1JFU1VMVF9NQVhfQ0hBUlMgcGx1cyB0aGVcblx0Ly8gZnJhbWluZyBtYXJrZXIsIHNvIHRoZSBzZXJpYWxpemVkIG91dHB1dCBzaG91bGQgYmUgYSB0aW55IGZyYWN0aW9uIG9mXG5cdC8vIHRoZSByYXcgMzAwSyBjaGFycyBvZiBjb250ZW50LlxuXHRhc3NlcnQub2soXG5cdFx0c2VyaWFsaXplZC5sZW5ndGggPCAxMF8wMDAsXG5cdFx0YHNlcmlhbGl6ZWQgb3V0cHV0IHNob3VsZCBiZSBzbWFsbCBhZnRlciBjYXBwaW5nIGFsbCBibG9ja3MsIGdvdCAke3NlcmlhbGl6ZWQubGVuZ3RofSBjaGFyc2AsXG5cdCk7XG5cdGFzc2VydC5tYXRjaChzZXJpYWxpemVkLCAvbW9yZSBjaGFyYWN0ZXJzIHRydW5jYXRlZC8sIFwidHJ1bmNhdGlvbiBtYXJrZXIgcHJlc2VudFwiKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxZQUFZO0FBQ25CLE9BQU8sVUFBVTtBQUlqQixTQUFTLHVCQUF1QiwwQkFBMEI7QUFFMUQsS0FBSyw4RkFBOEYsTUFBTTtB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
