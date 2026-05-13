import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContextualTips } from "./contextual-tips.js";
const baseCtx = {
  input: "hello world",
  isStreaming: false,
  thinkingLevel: "off",
  contextPercent: void 0
};
describe("ContextualTips", () => {
  describe("shell-command-prefix tip", () => {
    it("fires for bare shell commands", () => {
      const tips = new ContextualTips();
      const result = tips.evaluate({ ...baseCtx, input: "ls -la" });
      assert.ok(result);
      assert.ok(result.includes("looks like a shell command"));
      assert.ok(result.includes("!"));
    });
    it("fires for various known commands", () => {
      for (const cmd of ["pwd", "cd src", "cat file.txt", "grep foo bar", "git status", "npm install", "docker ps"]) {
        const tips = new ContextualTips();
        const result = tips.evaluate({ ...baseCtx, input: cmd });
        assert.ok(result, `Expected tip for "${cmd}"`);
        assert.ok(result.includes("looks like a shell command"));
      }
    });
    it("does not fire for commands already prefixed with !", () => {
      const tips = new ContextualTips();
      const result = tips.evaluate({ ...baseCtx, input: "!ls -la" });
      assert.equal(result, null);
    });
    it("does not fire for commands prefixed with !!", () => {
      const tips = new ContextualTips();
      const result = tips.evaluate({ ...baseCtx, input: "!!ls -la" });
      assert.equal(result, null);
    });
    it("does not fire for slash commands", () => {
      const tips = new ContextualTips();
      const result = tips.evaluate({ ...baseCtx, input: "/clear" });
      assert.equal(result, null);
    });
    it("does not fire for unknown commands", () => {
      const tips = new ContextualTips();
      const result = tips.evaluate({ ...baseCtx, input: "please help me fix this bug" });
      assert.equal(result, null);
    });
    it("does not fire for very long inputs", () => {
      const tips = new ContextualTips();
      const longInput = "ls " + "a".repeat(200);
      const result = tips.evaluate({ ...baseCtx, input: longInput });
      assert.equal(result, null);
    });
    it("respects maxShows (2)", () => {
      const tips = new ContextualTips();
      tips.evaluate({ ...baseCtx, input: "ls" });
      tips.evaluate({ ...baseCtx, input: "pwd" });
      const third = tips.evaluate({ ...baseCtx, input: "cat foo" });
      assert.equal(third, null);
    });
  });
  describe("large-paste tip", () => {
    it("fires for large inputs", () => {
      const tips = new ContextualTips();
      const largeInput = "a".repeat(2500);
      const result = tips.evaluate({ ...baseCtx, input: largeInput });
      assert.ok(result);
      assert.ok(result.includes("Large inputs"));
    });
    it("does not fire for normal-length inputs", () => {
      const tips = new ContextualTips();
      const result = tips.evaluate({ ...baseCtx, input: "fix the login bug" });
      assert.equal(result, null);
    });
    it("does not fire for large bash commands", () => {
      const tips = new ContextualTips();
      const result = tips.evaluate({ ...baseCtx, input: "!" + "a".repeat(2500) });
      assert.equal(result, null);
    });
    it("respects maxShows (2)", () => {
      const tips = new ContextualTips();
      const large = "x".repeat(3e3);
      tips.evaluate({ ...baseCtx, input: large });
      tips.evaluate({ ...baseCtx, input: large });
      const third = tips.evaluate({ ...baseCtx, input: large });
      assert.equal(third, null);
    });
  });
  describe("thinking-level-high tip", () => {
    it("fires for short inputs with high thinking", () => {
      const tips = new ContextualTips();
      const result = tips.evaluate({ ...baseCtx, input: "what is 2+2?", thinkingLevel: "high" });
      assert.ok(result);
      assert.ok(result.includes("Thinking is set to high"));
    });
    it("fires for xhigh thinking", () => {
      const tips = new ContextualTips();
      const result = tips.evaluate({ ...baseCtx, input: "what time is it?", thinkingLevel: "xhigh" });
      assert.ok(result);
      assert.ok(result.includes("Thinking is set to xhigh"));
    });
    it("does not fire for low/medium thinking", () => {
      const tips = new ContextualTips();
      const result = tips.evaluate({ ...baseCtx, input: "what is 2+2?", thinkingLevel: "medium" });
      assert.equal(result, null);
    });
    it("does not fire for long inputs", () => {
      const tips = new ContextualTips();
      const longInput = "Please help me refactor this entire authentication module to use JWT tokens instead of session cookies. I need to update the middleware, the login handler, and the user model.";
      const result = tips.evaluate({ ...baseCtx, input: longInput, thinkingLevel: "high" });
      assert.equal(result, null);
    });
    it("does not fire for slash commands", () => {
      const tips = new ContextualTips();
      const result = tips.evaluate({ ...baseCtx, input: "/model", thinkingLevel: "high" });
      assert.equal(result, null);
    });
    it("respects maxShows (1)", () => {
      const tips = new ContextualTips();
      tips.evaluate({ ...baseCtx, input: "hi", thinkingLevel: "high" });
      const second = tips.evaluate({ ...baseCtx, input: "hello", thinkingLevel: "high" });
      assert.equal(second, null);
    });
  });
  describe("double-bang-reminder tip", () => {
    it("fires after 3+ included bash commands", () => {
      const tips = new ContextualTips();
      tips.recordBashIncluded();
      tips.recordBashIncluded();
      tips.recordBashIncluded();
      const result = tips.evaluate({ ...baseCtx, input: "!ls" });
      assert.ok(result);
      assert.ok(result.includes("!!"));
    });
    it("does not fire with fewer than 3 included commands", () => {
      const tips = new ContextualTips();
      tips.recordBashIncluded();
      tips.recordBashIncluded();
      const result = tips.evaluate({ ...baseCtx, input: "!ls" });
      assert.equal(result, null);
    });
    it("does not fire for !! commands", () => {
      const tips = new ContextualTips();
      tips.recordBashIncluded();
      tips.recordBashIncluded();
      tips.recordBashIncluded();
      const result = tips.evaluate({ ...baseCtx, input: "!!ls" });
      assert.equal(result, null);
    });
    it("respects maxShows (2)", () => {
      const tips = new ContextualTips();
      for (let i = 0; i < 5; i++) tips.recordBashIncluded();
      tips.evaluate({ ...baseCtx, input: "!ls" });
      tips.evaluate({ ...baseCtx, input: "!pwd" });
      const third = tips.evaluate({ ...baseCtx, input: "!cat foo" });
      assert.equal(third, null);
    });
  });
  describe("compaction-nudge tip", () => {
    it("fires when context is >= 70%", () => {
      const tips = new ContextualTips();
      const result = tips.evaluate({ ...baseCtx, input: "fix the bug", contextPercent: 75 });
      assert.ok(result);
      assert.ok(result.includes("/compact"));
    });
    it("does not fire when context is < 70%", () => {
      const tips = new ContextualTips();
      const result = tips.evaluate({ ...baseCtx, input: "fix the bug", contextPercent: 50 });
      assert.equal(result, null);
    });
    it("does not fire when contextPercent is undefined", () => {
      const tips = new ContextualTips();
      const result = tips.evaluate({ ...baseCtx, input: "fix the bug", contextPercent: void 0 });
      assert.equal(result, null);
    });
    it("does not fire for slash commands", () => {
      const tips = new ContextualTips();
      const result = tips.evaluate({ ...baseCtx, input: "/model", contextPercent: 90 });
      assert.equal(result, null);
    });
    it("respects maxShows (1)", () => {
      const tips = new ContextualTips();
      tips.evaluate({ ...baseCtx, input: "hello", contextPercent: 80 });
      const second = tips.evaluate({ ...baseCtx, input: "world", contextPercent: 85 });
      assert.equal(second, null);
    });
  });
  describe("reset", () => {
    it("resets all show counters", () => {
      const tips = new ContextualTips();
      tips.evaluate({ ...baseCtx, input: "ls" });
      tips.evaluate({ ...baseCtx, input: "pwd" });
      assert.equal(tips.evaluate({ ...baseCtx, input: "cat foo" }), null);
      tips.reset();
      const result = tips.evaluate({ ...baseCtx, input: "ls" });
      assert.ok(result);
      assert.ok(result.includes("looks like a shell command"));
    });
    it("resets bash included count", () => {
      const tips = new ContextualTips();
      for (let i = 0; i < 5; i++) tips.recordBashIncluded();
      assert.equal(tips.bashIncludedCount, 5);
      tips.reset();
      assert.equal(tips.bashIncludedCount, 0);
    });
  });
  describe("priority \u2014 first match wins", () => {
    it("shell-command-prefix takes priority over compaction nudge", () => {
      const tips = new ContextualTips();
      const result = tips.evaluate({ ...baseCtx, input: "ls", contextPercent: 80 });
      assert.ok(result);
      assert.ok(result.includes("looks like a shell command"));
    });
    it("large-paste takes priority over compaction nudge", () => {
      const tips = new ContextualTips();
      const largeInput = "x".repeat(3e3);
      const result = tips.evaluate({ ...baseCtx, input: largeInput, contextPercent: 80 });
      assert.ok(result);
      assert.ok(result.includes("Large inputs"));
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2NvbnRleHR1YWwtdGlwcy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBkZXNjcmliZSwgaXQgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IENvbnRleHR1YWxUaXBzIH0gZnJvbSBcIi4vY29udGV4dHVhbC10aXBzLmpzXCI7XG5cbmNvbnN0IGJhc2VDdHggPSB7XG5cdGlucHV0OiBcImhlbGxvIHdvcmxkXCIsXG5cdGlzU3RyZWFtaW5nOiBmYWxzZSxcblx0dGhpbmtpbmdMZXZlbDogXCJvZmZcIiBhcyBzdHJpbmcsXG5cdGNvbnRleHRQZXJjZW50OiB1bmRlZmluZWQgYXMgbnVtYmVyIHwgdW5kZWZpbmVkLFxufTtcblxuZGVzY3JpYmUoXCJDb250ZXh0dWFsVGlwc1wiLCAoKSA9PiB7XG5cdGRlc2NyaWJlKFwic2hlbGwtY29tbWFuZC1wcmVmaXggdGlwXCIsICgpID0+IHtcblx0XHRpdChcImZpcmVzIGZvciBiYXJlIHNoZWxsIGNvbW1hbmRzXCIsICgpID0+IHtcblx0XHRcdGNvbnN0IHRpcHMgPSBuZXcgQ29udGV4dHVhbFRpcHMoKTtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IHRpcHMuZXZhbHVhdGUoeyAuLi5iYXNlQ3R4LCBpbnB1dDogXCJscyAtbGFcIiB9KTtcblx0XHRcdGFzc2VydC5vayhyZXN1bHQpO1xuXHRcdFx0YXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcImxvb2tzIGxpa2UgYSBzaGVsbCBjb21tYW5kXCIpKTtcblx0XHRcdGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCIhXCIpKTtcblx0XHR9KTtcblxuXHRcdGl0KFwiZmlyZXMgZm9yIHZhcmlvdXMga25vd24gY29tbWFuZHNcIiwgKCkgPT4ge1xuXHRcdFx0Zm9yIChjb25zdCBjbWQgb2YgW1wicHdkXCIsIFwiY2Qgc3JjXCIsIFwiY2F0IGZpbGUudHh0XCIsIFwiZ3JlcCBmb28gYmFyXCIsIFwiZ2l0IHN0YXR1c1wiLCBcIm5wbSBpbnN0YWxsXCIsIFwiZG9ja2VyIHBzXCJdKSB7XG5cdFx0XHRcdGNvbnN0IHRpcHMgPSBuZXcgQ29udGV4dHVhbFRpcHMoKTtcblx0XHRcdFx0Y29uc3QgcmVzdWx0ID0gdGlwcy5ldmFsdWF0ZSh7IC4uLmJhc2VDdHgsIGlucHV0OiBjbWQgfSk7XG5cdFx0XHRcdGFzc2VydC5vayhyZXN1bHQsIGBFeHBlY3RlZCB0aXAgZm9yIFwiJHtjbWR9XCJgKTtcblx0XHRcdFx0YXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcImxvb2tzIGxpa2UgYSBzaGVsbCBjb21tYW5kXCIpKTtcblx0XHRcdH1cblx0XHR9KTtcblxuXHRcdGl0KFwiZG9lcyBub3QgZmlyZSBmb3IgY29tbWFuZHMgYWxyZWFkeSBwcmVmaXhlZCB3aXRoICFcIiwgKCkgPT4ge1xuXHRcdFx0Y29uc3QgdGlwcyA9IG5ldyBDb250ZXh0dWFsVGlwcygpO1xuXHRcdFx0Y29uc3QgcmVzdWx0ID0gdGlwcy5ldmFsdWF0ZSh7IC4uLmJhc2VDdHgsIGlucHV0OiBcIiFscyAtbGFcIiB9KTtcblx0XHRcdGFzc2VydC5lcXVhbChyZXN1bHQsIG51bGwpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJkb2VzIG5vdCBmaXJlIGZvciBjb21tYW5kcyBwcmVmaXhlZCB3aXRoICEhXCIsICgpID0+IHtcblx0XHRcdGNvbnN0IHRpcHMgPSBuZXcgQ29udGV4dHVhbFRpcHMoKTtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IHRpcHMuZXZhbHVhdGUoeyAuLi5iYXNlQ3R4LCBpbnB1dDogXCIhIWxzIC1sYVwiIH0pO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgbnVsbCk7XG5cdFx0fSk7XG5cblx0XHRpdChcImRvZXMgbm90IGZpcmUgZm9yIHNsYXNoIGNvbW1hbmRzXCIsICgpID0+IHtcblx0XHRcdGNvbnN0IHRpcHMgPSBuZXcgQ29udGV4dHVhbFRpcHMoKTtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IHRpcHMuZXZhbHVhdGUoeyAuLi5iYXNlQ3R4LCBpbnB1dDogXCIvY2xlYXJcIiB9KTtcblx0XHRcdGFzc2VydC5lcXVhbChyZXN1bHQsIG51bGwpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJkb2VzIG5vdCBmaXJlIGZvciB1bmtub3duIGNvbW1hbmRzXCIsICgpID0+IHtcblx0XHRcdGNvbnN0IHRpcHMgPSBuZXcgQ29udGV4dHVhbFRpcHMoKTtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IHRpcHMuZXZhbHVhdGUoeyAuLi5iYXNlQ3R4LCBpbnB1dDogXCJwbGVhc2UgaGVscCBtZSBmaXggdGhpcyBidWdcIiB9KTtcblx0XHRcdGFzc2VydC5lcXVhbChyZXN1bHQsIG51bGwpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJkb2VzIG5vdCBmaXJlIGZvciB2ZXJ5IGxvbmcgaW5wdXRzXCIsICgpID0+IHtcblx0XHRcdGNvbnN0IHRpcHMgPSBuZXcgQ29udGV4dHVhbFRpcHMoKTtcblx0XHRcdGNvbnN0IGxvbmdJbnB1dCA9IFwibHMgXCIgKyBcImFcIi5yZXBlYXQoMjAwKTtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IHRpcHMuZXZhbHVhdGUoeyAuLi5iYXNlQ3R4LCBpbnB1dDogbG9uZ0lucHV0IH0pO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgbnVsbCk7XG5cdFx0fSk7XG5cblx0XHRpdChcInJlc3BlY3RzIG1heFNob3dzICgyKVwiLCAoKSA9PiB7XG5cdFx0XHRjb25zdCB0aXBzID0gbmV3IENvbnRleHR1YWxUaXBzKCk7XG5cdFx0XHR0aXBzLmV2YWx1YXRlKHsgLi4uYmFzZUN0eCwgaW5wdXQ6IFwibHNcIiB9KTtcblx0XHRcdHRpcHMuZXZhbHVhdGUoeyAuLi5iYXNlQ3R4LCBpbnB1dDogXCJwd2RcIiB9KTtcblx0XHRcdGNvbnN0IHRoaXJkID0gdGlwcy5ldmFsdWF0ZSh7IC4uLmJhc2VDdHgsIGlucHV0OiBcImNhdCBmb29cIiB9KTtcblx0XHRcdGFzc2VydC5lcXVhbCh0aGlyZCwgbnVsbCk7XG5cdFx0fSk7XG5cdH0pO1xuXG5cdGRlc2NyaWJlKFwibGFyZ2UtcGFzdGUgdGlwXCIsICgpID0+IHtcblx0XHRpdChcImZpcmVzIGZvciBsYXJnZSBpbnB1dHNcIiwgKCkgPT4ge1xuXHRcdFx0Y29uc3QgdGlwcyA9IG5ldyBDb250ZXh0dWFsVGlwcygpO1xuXHRcdFx0Y29uc3QgbGFyZ2VJbnB1dCA9IFwiYVwiLnJlcGVhdCgyNTAwKTtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IHRpcHMuZXZhbHVhdGUoeyAuLi5iYXNlQ3R4LCBpbnB1dDogbGFyZ2VJbnB1dCB9KTtcblx0XHRcdGFzc2VydC5vayhyZXN1bHQpO1xuXHRcdFx0YXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcIkxhcmdlIGlucHV0c1wiKSk7XG5cdFx0fSk7XG5cblx0XHRpdChcImRvZXMgbm90IGZpcmUgZm9yIG5vcm1hbC1sZW5ndGggaW5wdXRzXCIsICgpID0+IHtcblx0XHRcdGNvbnN0IHRpcHMgPSBuZXcgQ29udGV4dHVhbFRpcHMoKTtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IHRpcHMuZXZhbHVhdGUoeyAuLi5iYXNlQ3R4LCBpbnB1dDogXCJmaXggdGhlIGxvZ2luIGJ1Z1wiIH0pO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgbnVsbCk7XG5cdFx0fSk7XG5cblx0XHRpdChcImRvZXMgbm90IGZpcmUgZm9yIGxhcmdlIGJhc2ggY29tbWFuZHNcIiwgKCkgPT4ge1xuXHRcdFx0Y29uc3QgdGlwcyA9IG5ldyBDb250ZXh0dWFsVGlwcygpO1xuXHRcdFx0Y29uc3QgcmVzdWx0ID0gdGlwcy5ldmFsdWF0ZSh7IC4uLmJhc2VDdHgsIGlucHV0OiBcIiFcIiArIFwiYVwiLnJlcGVhdCgyNTAwKSB9KTtcblx0XHRcdGFzc2VydC5lcXVhbChyZXN1bHQsIG51bGwpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJyZXNwZWN0cyBtYXhTaG93cyAoMilcIiwgKCkgPT4ge1xuXHRcdFx0Y29uc3QgdGlwcyA9IG5ldyBDb250ZXh0dWFsVGlwcygpO1xuXHRcdFx0Y29uc3QgbGFyZ2UgPSBcInhcIi5yZXBlYXQoMzAwMCk7XG5cdFx0XHR0aXBzLmV2YWx1YXRlKHsgLi4uYmFzZUN0eCwgaW5wdXQ6IGxhcmdlIH0pO1xuXHRcdFx0dGlwcy5ldmFsdWF0ZSh7IC4uLmJhc2VDdHgsIGlucHV0OiBsYXJnZSB9KTtcblx0XHRcdGNvbnN0IHRoaXJkID0gdGlwcy5ldmFsdWF0ZSh7IC4uLmJhc2VDdHgsIGlucHV0OiBsYXJnZSB9KTtcblx0XHRcdGFzc2VydC5lcXVhbCh0aGlyZCwgbnVsbCk7XG5cdFx0fSk7XG5cdH0pO1xuXG5cdGRlc2NyaWJlKFwidGhpbmtpbmctbGV2ZWwtaGlnaCB0aXBcIiwgKCkgPT4ge1xuXHRcdGl0KFwiZmlyZXMgZm9yIHNob3J0IGlucHV0cyB3aXRoIGhpZ2ggdGhpbmtpbmdcIiwgKCkgPT4ge1xuXHRcdFx0Y29uc3QgdGlwcyA9IG5ldyBDb250ZXh0dWFsVGlwcygpO1xuXHRcdFx0Y29uc3QgcmVzdWx0ID0gdGlwcy5ldmFsdWF0ZSh7IC4uLmJhc2VDdHgsIGlucHV0OiBcIndoYXQgaXMgMisyP1wiLCB0aGlua2luZ0xldmVsOiBcImhpZ2hcIiB9KTtcblx0XHRcdGFzc2VydC5vayhyZXN1bHQpO1xuXHRcdFx0YXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcIlRoaW5raW5nIGlzIHNldCB0byBoaWdoXCIpKTtcblx0XHR9KTtcblxuXHRcdGl0KFwiZmlyZXMgZm9yIHhoaWdoIHRoaW5raW5nXCIsICgpID0+IHtcblx0XHRcdGNvbnN0IHRpcHMgPSBuZXcgQ29udGV4dHVhbFRpcHMoKTtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IHRpcHMuZXZhbHVhdGUoeyAuLi5iYXNlQ3R4LCBpbnB1dDogXCJ3aGF0IHRpbWUgaXMgaXQ/XCIsIHRoaW5raW5nTGV2ZWw6IFwieGhpZ2hcIiB9KTtcblx0XHRcdGFzc2VydC5vayhyZXN1bHQpO1xuXHRcdFx0YXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcIlRoaW5raW5nIGlzIHNldCB0byB4aGlnaFwiKSk7XG5cdFx0fSk7XG5cblx0XHRpdChcImRvZXMgbm90IGZpcmUgZm9yIGxvdy9tZWRpdW0gdGhpbmtpbmdcIiwgKCkgPT4ge1xuXHRcdFx0Y29uc3QgdGlwcyA9IG5ldyBDb250ZXh0dWFsVGlwcygpO1xuXHRcdFx0Y29uc3QgcmVzdWx0ID0gdGlwcy5ldmFsdWF0ZSh7IC4uLmJhc2VDdHgsIGlucHV0OiBcIndoYXQgaXMgMisyP1wiLCB0aGlua2luZ0xldmVsOiBcIm1lZGl1bVwiIH0pO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgbnVsbCk7XG5cdFx0fSk7XG5cblx0XHRpdChcImRvZXMgbm90IGZpcmUgZm9yIGxvbmcgaW5wdXRzXCIsICgpID0+IHtcblx0XHRcdGNvbnN0IHRpcHMgPSBuZXcgQ29udGV4dHVhbFRpcHMoKTtcblx0XHRcdGNvbnN0IGxvbmdJbnB1dCA9IFwiUGxlYXNlIGhlbHAgbWUgcmVmYWN0b3IgdGhpcyBlbnRpcmUgYXV0aGVudGljYXRpb24gbW9kdWxlIHRvIHVzZSBKV1QgdG9rZW5zIGluc3RlYWQgb2Ygc2Vzc2lvbiBjb29raWVzLiBcIiArXG5cdFx0XHRcdFwiSSBuZWVkIHRvIHVwZGF0ZSB0aGUgbWlkZGxld2FyZSwgdGhlIGxvZ2luIGhhbmRsZXIsIGFuZCB0aGUgdXNlciBtb2RlbC5cIjtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IHRpcHMuZXZhbHVhdGUoeyAuLi5iYXNlQ3R4LCBpbnB1dDogbG9uZ0lucHV0LCB0aGlua2luZ0xldmVsOiBcImhpZ2hcIiB9KTtcblx0XHRcdGFzc2VydC5lcXVhbChyZXN1bHQsIG51bGwpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJkb2VzIG5vdCBmaXJlIGZvciBzbGFzaCBjb21tYW5kc1wiLCAoKSA9PiB7XG5cdFx0XHRjb25zdCB0aXBzID0gbmV3IENvbnRleHR1YWxUaXBzKCk7XG5cdFx0XHRjb25zdCByZXN1bHQgPSB0aXBzLmV2YWx1YXRlKHsgLi4uYmFzZUN0eCwgaW5wdXQ6IFwiL21vZGVsXCIsIHRoaW5raW5nTGV2ZWw6IFwiaGlnaFwiIH0pO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgbnVsbCk7XG5cdFx0fSk7XG5cblx0XHRpdChcInJlc3BlY3RzIG1heFNob3dzICgxKVwiLCAoKSA9PiB7XG5cdFx0XHRjb25zdCB0aXBzID0gbmV3IENvbnRleHR1YWxUaXBzKCk7XG5cdFx0XHR0aXBzLmV2YWx1YXRlKHsgLi4uYmFzZUN0eCwgaW5wdXQ6IFwiaGlcIiwgdGhpbmtpbmdMZXZlbDogXCJoaWdoXCIgfSk7XG5cdFx0XHRjb25zdCBzZWNvbmQgPSB0aXBzLmV2YWx1YXRlKHsgLi4uYmFzZUN0eCwgaW5wdXQ6IFwiaGVsbG9cIiwgdGhpbmtpbmdMZXZlbDogXCJoaWdoXCIgfSk7XG5cdFx0XHRhc3NlcnQuZXF1YWwoc2Vjb25kLCBudWxsKTtcblx0XHR9KTtcblx0fSk7XG5cblx0ZGVzY3JpYmUoXCJkb3VibGUtYmFuZy1yZW1pbmRlciB0aXBcIiwgKCkgPT4ge1xuXHRcdGl0KFwiZmlyZXMgYWZ0ZXIgMysgaW5jbHVkZWQgYmFzaCBjb21tYW5kc1wiLCAoKSA9PiB7XG5cdFx0XHRjb25zdCB0aXBzID0gbmV3IENvbnRleHR1YWxUaXBzKCk7XG5cdFx0XHR0aXBzLnJlY29yZEJhc2hJbmNsdWRlZCgpO1xuXHRcdFx0dGlwcy5yZWNvcmRCYXNoSW5jbHVkZWQoKTtcblx0XHRcdHRpcHMucmVjb3JkQmFzaEluY2x1ZGVkKCk7XG5cdFx0XHRjb25zdCByZXN1bHQgPSB0aXBzLmV2YWx1YXRlKHsgLi4uYmFzZUN0eCwgaW5wdXQ6IFwiIWxzXCIgfSk7XG5cdFx0XHRhc3NlcnQub2socmVzdWx0KTtcblx0XHRcdGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCIhIVwiKSk7XG5cdFx0fSk7XG5cblx0XHRpdChcImRvZXMgbm90IGZpcmUgd2l0aCBmZXdlciB0aGFuIDMgaW5jbHVkZWQgY29tbWFuZHNcIiwgKCkgPT4ge1xuXHRcdFx0Y29uc3QgdGlwcyA9IG5ldyBDb250ZXh0dWFsVGlwcygpO1xuXHRcdFx0dGlwcy5yZWNvcmRCYXNoSW5jbHVkZWQoKTtcblx0XHRcdHRpcHMucmVjb3JkQmFzaEluY2x1ZGVkKCk7XG5cdFx0XHRjb25zdCByZXN1bHQgPSB0aXBzLmV2YWx1YXRlKHsgLi4uYmFzZUN0eCwgaW5wdXQ6IFwiIWxzXCIgfSk7XG5cdFx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LCBudWxsKTtcblx0XHR9KTtcblxuXHRcdGl0KFwiZG9lcyBub3QgZmlyZSBmb3IgISEgY29tbWFuZHNcIiwgKCkgPT4ge1xuXHRcdFx0Y29uc3QgdGlwcyA9IG5ldyBDb250ZXh0dWFsVGlwcygpO1xuXHRcdFx0dGlwcy5yZWNvcmRCYXNoSW5jbHVkZWQoKTtcblx0XHRcdHRpcHMucmVjb3JkQmFzaEluY2x1ZGVkKCk7XG5cdFx0XHR0aXBzLnJlY29yZEJhc2hJbmNsdWRlZCgpO1xuXHRcdFx0Y29uc3QgcmVzdWx0ID0gdGlwcy5ldmFsdWF0ZSh7IC4uLmJhc2VDdHgsIGlucHV0OiBcIiEhbHNcIiB9KTtcblx0XHRcdGFzc2VydC5lcXVhbChyZXN1bHQsIG51bGwpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJyZXNwZWN0cyBtYXhTaG93cyAoMilcIiwgKCkgPT4ge1xuXHRcdFx0Y29uc3QgdGlwcyA9IG5ldyBDb250ZXh0dWFsVGlwcygpO1xuXHRcdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCA1OyBpKyspIHRpcHMucmVjb3JkQmFzaEluY2x1ZGVkKCk7XG5cdFx0XHR0aXBzLmV2YWx1YXRlKHsgLi4uYmFzZUN0eCwgaW5wdXQ6IFwiIWxzXCIgfSk7XG5cdFx0XHR0aXBzLmV2YWx1YXRlKHsgLi4uYmFzZUN0eCwgaW5wdXQ6IFwiIXB3ZFwiIH0pO1xuXHRcdFx0Y29uc3QgdGhpcmQgPSB0aXBzLmV2YWx1YXRlKHsgLi4uYmFzZUN0eCwgaW5wdXQ6IFwiIWNhdCBmb29cIiB9KTtcblx0XHRcdGFzc2VydC5lcXVhbCh0aGlyZCwgbnVsbCk7XG5cdFx0fSk7XG5cdH0pO1xuXG5cdGRlc2NyaWJlKFwiY29tcGFjdGlvbi1udWRnZSB0aXBcIiwgKCkgPT4ge1xuXHRcdGl0KFwiZmlyZXMgd2hlbiBjb250ZXh0IGlzID49IDcwJVwiLCAoKSA9PiB7XG5cdFx0XHRjb25zdCB0aXBzID0gbmV3IENvbnRleHR1YWxUaXBzKCk7XG5cdFx0XHRjb25zdCByZXN1bHQgPSB0aXBzLmV2YWx1YXRlKHsgLi4uYmFzZUN0eCwgaW5wdXQ6IFwiZml4IHRoZSBidWdcIiwgY29udGV4dFBlcmNlbnQ6IDc1IH0pO1xuXHRcdFx0YXNzZXJ0Lm9rKHJlc3VsdCk7XG5cdFx0XHRhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwiL2NvbXBhY3RcIikpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJkb2VzIG5vdCBmaXJlIHdoZW4gY29udGV4dCBpcyA8IDcwJVwiLCAoKSA9PiB7XG5cdFx0XHRjb25zdCB0aXBzID0gbmV3IENvbnRleHR1YWxUaXBzKCk7XG5cdFx0XHRjb25zdCByZXN1bHQgPSB0aXBzLmV2YWx1YXRlKHsgLi4uYmFzZUN0eCwgaW5wdXQ6IFwiZml4IHRoZSBidWdcIiwgY29udGV4dFBlcmNlbnQ6IDUwIH0pO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgbnVsbCk7XG5cdFx0fSk7XG5cblx0XHRpdChcImRvZXMgbm90IGZpcmUgd2hlbiBjb250ZXh0UGVyY2VudCBpcyB1bmRlZmluZWRcIiwgKCkgPT4ge1xuXHRcdFx0Y29uc3QgdGlwcyA9IG5ldyBDb250ZXh0dWFsVGlwcygpO1xuXHRcdFx0Y29uc3QgcmVzdWx0ID0gdGlwcy5ldmFsdWF0ZSh7IC4uLmJhc2VDdHgsIGlucHV0OiBcImZpeCB0aGUgYnVnXCIsIGNvbnRleHRQZXJjZW50OiB1bmRlZmluZWQgfSk7XG5cdFx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LCBudWxsKTtcblx0XHR9KTtcblxuXHRcdGl0KFwiZG9lcyBub3QgZmlyZSBmb3Igc2xhc2ggY29tbWFuZHNcIiwgKCkgPT4ge1xuXHRcdFx0Y29uc3QgdGlwcyA9IG5ldyBDb250ZXh0dWFsVGlwcygpO1xuXHRcdFx0Y29uc3QgcmVzdWx0ID0gdGlwcy5ldmFsdWF0ZSh7IC4uLmJhc2VDdHgsIGlucHV0OiBcIi9tb2RlbFwiLCBjb250ZXh0UGVyY2VudDogOTAgfSk7XG5cdFx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LCBudWxsKTtcblx0XHR9KTtcblxuXHRcdGl0KFwicmVzcGVjdHMgbWF4U2hvd3MgKDEpXCIsICgpID0+IHtcblx0XHRcdGNvbnN0IHRpcHMgPSBuZXcgQ29udGV4dHVhbFRpcHMoKTtcblx0XHRcdHRpcHMuZXZhbHVhdGUoeyAuLi5iYXNlQ3R4LCBpbnB1dDogXCJoZWxsb1wiLCBjb250ZXh0UGVyY2VudDogODAgfSk7XG5cdFx0XHRjb25zdCBzZWNvbmQgPSB0aXBzLmV2YWx1YXRlKHsgLi4uYmFzZUN0eCwgaW5wdXQ6IFwid29ybGRcIiwgY29udGV4dFBlcmNlbnQ6IDg1IH0pO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHNlY29uZCwgbnVsbCk7XG5cdFx0fSk7XG5cdH0pO1xuXG5cdGRlc2NyaWJlKFwicmVzZXRcIiwgKCkgPT4ge1xuXHRcdGl0KFwicmVzZXRzIGFsbCBzaG93IGNvdW50ZXJzXCIsICgpID0+IHtcblx0XHRcdGNvbnN0IHRpcHMgPSBuZXcgQ29udGV4dHVhbFRpcHMoKTtcblx0XHRcdC8vIEV4aGF1c3Qgc2hlbGwtY29tbWFuZC1wcmVmaXggdGlwXG5cdFx0XHR0aXBzLmV2YWx1YXRlKHsgLi4uYmFzZUN0eCwgaW5wdXQ6IFwibHNcIiB9KTtcblx0XHRcdHRpcHMuZXZhbHVhdGUoeyAuLi5iYXNlQ3R4LCBpbnB1dDogXCJwd2RcIiB9KTtcblx0XHRcdGFzc2VydC5lcXVhbCh0aXBzLmV2YWx1YXRlKHsgLi4uYmFzZUN0eCwgaW5wdXQ6IFwiY2F0IGZvb1wiIH0pLCBudWxsKTtcblxuXHRcdFx0dGlwcy5yZXNldCgpO1xuXG5cdFx0XHQvLyBTaG91bGQgZmlyZSBhZ2FpbiBhZnRlciByZXNldFxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gdGlwcy5ldmFsdWF0ZSh7IC4uLmJhc2VDdHgsIGlucHV0OiBcImxzXCIgfSk7XG5cdFx0XHRhc3NlcnQub2socmVzdWx0KTtcblx0XHRcdGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJsb29rcyBsaWtlIGEgc2hlbGwgY29tbWFuZFwiKSk7XG5cdFx0fSk7XG5cblx0XHRpdChcInJlc2V0cyBiYXNoIGluY2x1ZGVkIGNvdW50XCIsICgpID0+IHtcblx0XHRcdGNvbnN0IHRpcHMgPSBuZXcgQ29udGV4dHVhbFRpcHMoKTtcblx0XHRcdGZvciAobGV0IGkgPSAwOyBpIDwgNTsgaSsrKSB0aXBzLnJlY29yZEJhc2hJbmNsdWRlZCgpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHRpcHMuYmFzaEluY2x1ZGVkQ291bnQsIDUpO1xuXG5cdFx0XHR0aXBzLnJlc2V0KCk7XG5cdFx0XHRhc3NlcnQuZXF1YWwodGlwcy5iYXNoSW5jbHVkZWRDb3VudCwgMCk7XG5cdFx0fSk7XG5cdH0pO1xuXG5cdGRlc2NyaWJlKFwicHJpb3JpdHkgXHUyMDE0IGZpcnN0IG1hdGNoIHdpbnNcIiwgKCkgPT4ge1xuXHRcdGl0KFwic2hlbGwtY29tbWFuZC1wcmVmaXggdGFrZXMgcHJpb3JpdHkgb3ZlciBjb21wYWN0aW9uIG51ZGdlXCIsICgpID0+IHtcblx0XHRcdGNvbnN0IHRpcHMgPSBuZXcgQ29udGV4dHVhbFRpcHMoKTtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IHRpcHMuZXZhbHVhdGUoeyAuLi5iYXNlQ3R4LCBpbnB1dDogXCJsc1wiLCBjb250ZXh0UGVyY2VudDogODAgfSk7XG5cdFx0XHRhc3NlcnQub2socmVzdWx0KTtcblx0XHRcdGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJsb29rcyBsaWtlIGEgc2hlbGwgY29tbWFuZFwiKSk7XG5cdFx0fSk7XG5cblx0XHRpdChcImxhcmdlLXBhc3RlIHRha2VzIHByaW9yaXR5IG92ZXIgY29tcGFjdGlvbiBudWRnZVwiLCAoKSA9PiB7XG5cdFx0XHRjb25zdCB0aXBzID0gbmV3IENvbnRleHR1YWxUaXBzKCk7XG5cdFx0XHRjb25zdCBsYXJnZUlucHV0ID0gXCJ4XCIucmVwZWF0KDMwMDApO1xuXHRcdFx0Y29uc3QgcmVzdWx0ID0gdGlwcy5ldmFsdWF0ZSh7IC4uLmJhc2VDdHgsIGlucHV0OiBsYXJnZUlucHV0LCBjb250ZXh0UGVyY2VudDogODAgfSk7XG5cdFx0XHRhc3NlcnQub2socmVzdWx0KTtcblx0XHRcdGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJMYXJnZSBpbnB1dHNcIikpO1xuXHRcdH0pO1xuXHR9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLFVBQVU7QUFDN0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsc0JBQXNCO0FBRS9CLE1BQU0sVUFBVTtBQUFBLEVBQ2YsT0FBTztBQUFBLEVBQ1AsYUFBYTtBQUFBLEVBQ2IsZUFBZTtBQUFBLEVBQ2YsZ0JBQWdCO0FBQ2pCO0FBRUEsU0FBUyxrQkFBa0IsTUFBTTtBQUNoQyxXQUFTLDRCQUE0QixNQUFNO0FBQzFDLE9BQUcsaUNBQWlDLE1BQU07QUFDekMsWUFBTSxPQUFPLElBQUksZUFBZTtBQUNoQyxZQUFNLFNBQVMsS0FBSyxTQUFTLEVBQUUsR0FBRyxTQUFTLE9BQU8sU0FBUyxDQUFDO0FBQzVELGFBQU8sR0FBRyxNQUFNO0FBQ2hCLGFBQU8sR0FBRyxPQUFPLFNBQVMsNEJBQTRCLENBQUM7QUFDdkQsYUFBTyxHQUFHLE9BQU8sU0FBUyxHQUFHLENBQUM7QUFBQSxJQUMvQixDQUFDO0FBRUQsT0FBRyxvQ0FBb0MsTUFBTTtBQUM1QyxpQkFBVyxPQUFPLENBQUMsT0FBTyxVQUFVLGdCQUFnQixnQkFBZ0IsY0FBYyxlQUFlLFdBQVcsR0FBRztBQUM5RyxjQUFNLE9BQU8sSUFBSSxlQUFlO0FBQ2hDLGNBQU0sU0FBUyxLQUFLLFNBQVMsRUFBRSxHQUFHLFNBQVMsT0FBTyxJQUFJLENBQUM7QUFDdkQsZUFBTyxHQUFH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
