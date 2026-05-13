import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "./session-manager.js";
function makeAssistantMessage(input, output, cacheRead = 0, cacheWrite = 0, cost = 0) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      total: input + output + cacheRead + cacheWrite,
      cost: { total: cost }
    }
  };
}
describe("SessionManager usage totals", () => {
  let dir;
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("tracks assistant usage incrementally without rescanning entries", () => {
    dir = mkdtempSync(join(tmpdir(), "gsd-session-manager-test-"));
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }] });
    manager.appendMessage(makeAssistantMessage(10, 5, 3, 2, 0.25));
    manager.appendMessage(makeAssistantMessage(7, 4, 1, 0, 0.1));
    assert.deepEqual(manager.getUsageTotals(), {
      input: 17,
      output: 9,
      cacheRead: 4,
      cacheWrite: 2,
      cost: 0.35
    });
  });
  it("resets totals when starting a new session", () => {
    dir = mkdtempSync(join(tmpdir(), "gsd-session-manager-test-"));
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage(makeAssistantMessage(5, 5, 0, 0, 0.05));
    assert.equal(manager.getUsageTotals().input, 5);
    manager.newSession();
    assert.deepEqual(manager.getUsageTotals(), {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0
    });
  });
});
describe("SessionManager secret redaction on persistence", () => {
  let dir;
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("scrubs known secret shapes from JSONL on disk", () => {
    dir = mkdtempSync(join(tmpdir(), "gsd-session-redact-test-"));
    const manager = SessionManager.create(dir, dir);
    const leakedKey = "llx-abcDEF1234567890abcDEF1234567890";
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: `here is my key: ${leakedKey}` }]
    });
    manager.appendMessage(makeAssistantMessage(1, 1, 0, 0, 0));
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile, "session file should be set");
    const contents = readFileSync(sessionFile, "utf8");
    assert.ok(
      !contents.includes(leakedKey),
      "raw secret must not appear in persisted JSONL"
    );
    assert.ok(
      contents.includes("[REDACTED:llamacloud]"),
      "redaction placeholder must appear in persisted JSONL"
    );
  });
  it("scrubs secrets from JSONL rewritten by _rewriteFile() during migration", () => {
    dir = mkdtempSync(join(tmpdir(), "gsd-session-rewrite-redact-test-"));
    const leakedKey = "sk-ant-api03-abcDEF1234567890abcDEF1234567890xYz";
    const v1Header = JSON.stringify({ type: "session", version: 1, id: "test-session-id", timestamp: (/* @__PURE__ */ new Date()).toISOString(), cwd: dir });
    const v1UserMsg = JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `secret: ${leakedKey}` }] } });
    const v1AssistantMsg = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: { total: 0 } } } });
    const sessionFile = join(dir, "test-session.jsonl");
    writeFileSync(sessionFile, [v1Header, v1UserMsg, v1AssistantMsg].join("\n") + "\n", "utf8");
    const manager = SessionManager.create(dir, dir);
    manager.setSessionFile(sessionFile);
    const contents = readFileSync(sessionFile, "utf8");
    assert.ok(
      !contents.includes(leakedKey),
      "raw secret must not appear in JSONL rewritten by _rewriteFile()"
    );
    assert.ok(
      contents.includes("[REDACTED:anthropic]"),
      "redaction placeholder must appear in JSONL rewritten by _rewriteFile()"
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Nlc3Npb24tbWFuYWdlci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGRlc2NyaWJlLCBpdCwgYWZ0ZXJFYWNoIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIHJlYWRGaWxlU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyBTZXNzaW9uTWFuYWdlciB9IGZyb20gXCIuL3Nlc3Npb24tbWFuYWdlci5qc1wiO1xuXG5mdW5jdGlvbiBtYWtlQXNzaXN0YW50TWVzc2FnZShpbnB1dDogbnVtYmVyLCBvdXRwdXQ6IG51bWJlciwgY2FjaGVSZWFkID0gMCwgY2FjaGVXcml0ZSA9IDAsIGNvc3QgPSAwKSB7XG5cdHJldHVybiB7XG5cdFx0cm9sZTogXCJhc3Npc3RhbnRcIixcblx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJva1wiIH1dLFxuXHRcdHVzYWdlOiB7XG5cdFx0XHRpbnB1dCxcblx0XHRcdG91dHB1dCxcblx0XHRcdGNhY2hlUmVhZCxcblx0XHRcdGNhY2hlV3JpdGUsXG5cdFx0XHR0b3RhbDogaW5wdXQgKyBvdXRwdXQgKyBjYWNoZVJlYWQgKyBjYWNoZVdyaXRlLFxuXHRcdFx0Y29zdDogeyB0b3RhbDogY29zdCB9LFxuXHRcdH0sXG5cdH0gYXMgYW55O1xufVxuXG5kZXNjcmliZShcIlNlc3Npb25NYW5hZ2VyIHVzYWdlIHRvdGFsc1wiLCAoKSA9PiB7XG5cdGxldCBkaXI6IHN0cmluZztcblxuXHRhZnRlckVhY2goKCkgPT4ge1xuXHRcdGlmIChkaXIpIHtcblx0XHRcdHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcblx0XHR9XG5cdH0pO1xuXG5cdGl0KFwidHJhY2tzIGFzc2lzdGFudCB1c2FnZSBpbmNyZW1lbnRhbGx5IHdpdGhvdXQgcmVzY2FubmluZyBlbnRyaWVzXCIsICgpID0+IHtcblx0XHRkaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1zZXNzaW9uLW1hbmFnZXItdGVzdC1cIikpO1xuXHRcdGNvbnN0IG1hbmFnZXIgPSBTZXNzaW9uTWFuYWdlci5jcmVhdGUoZGlyLCBkaXIpO1xuXG5cdFx0bWFuYWdlci5hcHBlbmRNZXNzYWdlKHsgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcImhlbGxvXCIgfV0gfSBhcyBhbnkpO1xuXHRcdG1hbmFnZXIuYXBwZW5kTWVzc2FnZShtYWtlQXNzaXN0YW50TWVzc2FnZSgxMCwgNSwgMywgMiwgMC4yNSkpO1xuXHRcdG1hbmFnZXIuYXBwZW5kTWVzc2FnZShtYWtlQXNzaXN0YW50TWVzc2FnZSg3LCA0LCAxLCAwLCAwLjEpKTtcblxuXHRcdGFzc2VydC5kZWVwRXF1YWwobWFuYWdlci5nZXRVc2FnZVRvdGFscygpLCB7XG5cdFx0XHRpbnB1dDogMTcsXG5cdFx0XHRvdXRwdXQ6IDksXG5cdFx0XHRjYWNoZVJlYWQ6IDQsXG5cdFx0XHRjYWNoZVdyaXRlOiAyLFxuXHRcdFx0Y29zdDogMC4zNSxcblx0XHR9KTtcblx0fSk7XG5cblx0aXQoXCJyZXNldHMgdG90YWxzIHdoZW4gc3RhcnRpbmcgYSBuZXcgc2Vzc2lvblwiLCAoKSA9PiB7XG5cdFx0ZGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtc2Vzc2lvbi1tYW5hZ2VyLXRlc3QtXCIpKTtcblx0XHRjb25zdCBtYW5hZ2VyID0gU2Vzc2lvbk1hbmFnZXIuY3JlYXRlKGRpciwgZGlyKTtcblx0XHRtYW5hZ2VyLmFwcGVuZE1lc3NhZ2UobWFrZUFzc2lzdGFudE1lc3NhZ2UoNSwgNSwgMCwgMCwgMC4wNSkpO1xuXHRcdGFzc2VydC5lcXVhbChtYW5hZ2VyLmdldFVzYWdlVG90YWxzKCkuaW5wdXQsIDUpO1xuXG5cdFx0bWFuYWdlci5uZXdTZXNzaW9uKCk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChtYW5hZ2VyLmdldFVzYWdlVG90YWxzKCksIHtcblx0XHRcdGlucHV0OiAwLFxuXHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdGNvc3Q6IDAsXG5cdFx0fSk7XG5cdH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiU2Vzc2lvbk1hbmFnZXIgc2VjcmV0IHJlZGFjdGlvbiBvbiBwZXJzaXN0ZW5jZVwiLCAoKSA9PiB7XG5cdGxldCBkaXI6IHN0cmluZztcblxuXHRhZnRlckVhY2goKCkgPT4ge1xuXHRcdGlmIChkaXIpIHtcblx0XHRcdHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcblx0XHR9XG5cdH0pO1xuXG5cdGl0KFwic2NydWJzIGtub3duIHNlY3JldCBzaGFwZXMgZnJvbSBKU09OTCBvbiBkaXNrXCIsICgpID0+IHtcblx0XHRkaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1zZXNzaW9uLXJlZGFjdC10ZXN0LVwiKSk7XG5cdFx0Y29uc3QgbWFuYWdlciA9IFNlc3Npb25NYW5hZ2VyLmNyZWF0ZShkaXIsIGRpcik7XG5cblx0XHRjb25zdCBsZWFrZWRLZXkgPSBcImxseC1hYmNERUYxMjM0NTY3ODkwYWJjREVGMTIzNDU2Nzg5MFwiO1xuXHRcdG1hbmFnZXIuYXBwZW5kTWVzc2FnZSh7XG5cdFx0XHRyb2xlOiBcInVzZXJcIixcblx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgaGVyZSBpcyBteSBrZXk6ICR7bGVha2VkS2V5fWAgfV0sXG5cdFx0fSBhcyBhbnkpO1xuXHRcdC8vIFBlcnNpc3RlbmNlIGlzIGdhdGVkIG9uIGFuIGFzc2lzdGFudCBtZXNzYWdlIGJlaW5nIHByZXNlbnQuXG5cdFx0bWFuYWdlci5hcHBlbmRNZXNzYWdlKG1ha2VBc3Npc3RhbnRNZXNzYWdlKDEsIDEsIDAsIDAsIDApKTtcblxuXHRcdGNvbnN0IHNlc3Npb25GaWxlID0gbWFuYWdlci5nZXRTZXNzaW9uRmlsZSgpO1xuXHRcdGFzc2VydC5vayhzZXNzaW9uRmlsZSwgXCJzZXNzaW9uIGZpbGUgc2hvdWxkIGJlIHNldFwiKTtcblx0XHRjb25zdCBjb250ZW50cyA9IHJlYWRGaWxlU3luYyhzZXNzaW9uRmlsZSEsIFwidXRmOFwiKTtcblx0XHRhc3NlcnQub2soXG5cdFx0XHQhY29udGVudHMuaW5jbHVkZXMobGVha2VkS2V5KSxcblx0XHRcdFwicmF3IHNlY3JldCBtdXN0IG5vdCBhcHBlYXIgaW4gcGVyc2lzdGVkIEpTT05MXCIsXG5cdFx0KTtcblx0XHRhc3NlcnQub2soXG5cdFx0XHRjb250ZW50cy5pbmNsdWRlcyhcIltSRURBQ1RFRDpsbGFtYWNsb3VkXVwiKSxcblx0XHRcdFwicmVkYWN0aW9uIHBsYWNlaG9sZGVyIG11c3QgYXBwZWFyIGluIHBlcnNpc3RlZCBKU09OTFwiLFxuXHRcdCk7XG5cdH0pO1xuXG5cdGl0KFwic2NydWJzIHNlY3JldHMgZnJvbSBKU09OTCByZXdyaXR0ZW4gYnkgX3Jld3JpdGVGaWxlKCkgZHVyaW5nIG1pZ3JhdGlvblwiLCAoKSA9PiB7XG5cdFx0Ly8gV3JpdGUgYSB2MSBzZXNzaW9uIGZpbGUgKG5vIGlkL3BhcmVudElkIG9uIGVudHJpZXMpIGNvbnRhaW5pbmcgYSBzZWNyZXQuXG5cdFx0Ly8gc2V0U2Vzc2lvbkZpbGUoKSB3aWxsIGRldGVjdCB2ZXJzaW9uIDwgMywgcnVuIG1pZ3JhdGlvbiwgYW5kIGNhbGwgX3Jld3JpdGVGaWxlKClcblx0XHQvLyB3aGljaCBwcmV2aW91c2x5IHNlcmlhbGlzZWQgZW50cmllcyB3aXRob3V0IHBhc3NpbmcgdGhlbSB0aHJvdWdoIHJlZGFjdGlvbi5cblx0XHRkaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1zZXNzaW9uLXJld3JpdGUtcmVkYWN0LXRlc3QtXCIpKTtcblx0XHRjb25zdCBsZWFrZWRLZXkgPSBcInNrLWFudC1hcGkwMy1hYmNERUYxMjM0NTY3ODkwYWJjREVGMTIzNDU2Nzg5MHhZelwiO1xuXHRcdGNvbnN0IHYxSGVhZGVyID0gSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcInNlc3Npb25cIiwgdmVyc2lvbjogMSwgaWQ6IFwidGVzdC1zZXNzaW9uLWlkXCIsIHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCBjd2Q6IGRpciB9KTtcblx0XHRjb25zdCB2MVVzZXJNc2cgPSBKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwibWVzc2FnZVwiLCBtZXNzYWdlOiB7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYHNlY3JldDogJHtsZWFrZWRLZXl9YCB9XSB9IH0pO1xuXHRcdGNvbnN0IHYxQXNzaXN0YW50TXNnID0gSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcIm1lc3NhZ2VcIiwgbWVzc2FnZTogeyByb2xlOiBcImFzc2lzdGFudFwiLCBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJva1wiIH1dLCB1c2FnZTogeyBpbnB1dDogMSwgb3V0cHV0OiAxLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIHRvdGFsOiAyLCBjb3N0OiB7IHRvdGFsOiAwIH0gfSB9IH0pO1xuXHRcdGNvbnN0IHNlc3Npb25GaWxlID0gam9pbihkaXIsIFwidGVzdC1zZXNzaW9uLmpzb25sXCIpO1xuXHRcdHdyaXRlRmlsZVN5bmMoc2Vzc2lvbkZpbGUsIFt2MUhlYWRlciwgdjFVc2VyTXNnLCB2MUFzc2lzdGFudE1zZ10uam9pbihcIlxcblwiKSArIFwiXFxuXCIsIFwidXRmOFwiKTtcblxuXHRcdC8vIExvYWRpbmcgdGhpcyBmaWxlIHRyaWdnZXJzIG1pZ3JhdGVUb0N1cnJlbnRWZXJzaW9uKCkgd2hpY2ggcmV0dXJucyB0cnVlICh2MSBcdTIxOTIgdjMpLFxuXHRcdC8vIGNhdXNpbmcgX3Jld3JpdGVGaWxlKCkgdG8gcmV3cml0ZSB0aGUgZmlsZS4gVGhlIGJ1ZzogX3Jld3JpdGVGaWxlKCkgY2FsbGVkXG5cdFx0Ly8gSlNPTi5zdHJpbmdpZnkoZSkgd2l0aG91dCByZWRhY3Rpb24sIHNvIHRoZSBzZWNyZXQgd291bGQgc3Vydml2ZSBvbiBkaXNrLlxuXHRcdGNvbnN0IG1hbmFnZXIgPSBTZXNzaW9uTWFuYWdlci5jcmVhdGUoZGlyLCBkaXIpO1xuXHRcdG1hbmFnZXIuc2V0U2Vzc2lvbkZpbGUoc2Vzc2lvbkZpbGUpO1xuXG5cdFx0Y29uc3QgY29udGVudHMgPSByZWFkRmlsZVN5bmMoc2Vzc2lvbkZpbGUsIFwidXRmOFwiKTtcblx0XHRhc3NlcnQub2soXG5cdFx0XHQhY29udGVudHMuaW5jbHVkZXMobGVha2VkS2V5KSxcblx0XHRcdFwicmF3IHNlY3JldCBtdXN0IG5vdCBhcHBlYXIgaW4gSlNPTkwgcmV3cml0dGVuIGJ5IF9yZXdyaXRlRmlsZSgpXCIsXG5cdFx0KTtcblx0XHRhc3NlcnQub2soXG5cdFx0XHRjb250ZW50cy5pbmNsdWRlcyhcIltSRURBQ1RFRDphbnRocm9waWNdXCIpLFxuXHRcdFx0XCJyZWRhY3Rpb24gcGxhY2Vob2xkZXIgbXVzdCBhcHBlYXIgaW4gSlNPTkwgcmV3cml0dGVuIGJ5IF9yZXdyaXRlRmlsZSgpXCIsXG5cdFx0KTtcblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sWUFBWTtBQUNuQixTQUFTLFVBQVUsSUFBSSxpQkFBaUI7QUFDeEMsU0FBUyxhQUFhLGNBQWMsUUFBUSxxQkFBcUI7QUFDakUsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QixTQUFTLHNCQUFzQjtBQUUvQixTQUFTLHFCQUFxQixP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
