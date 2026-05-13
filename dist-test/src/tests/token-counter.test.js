import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  countTokens,
  countTokensSync,
  initTokenCounter,
  isAccurateCountingAvailable
} from "../resources/extensions/gsd/token-counter.js";
describe("token-counter", () => {
  it("countTokensSync returns heuristic estimate before init", () => {
    const count = countTokensSync("hello world");
    assert.equal(count, Math.ceil("hello world".length / 4));
  });
  it("initTokenCounter initializes the encoder", async () => {
    const result = await initTokenCounter();
    assert.equal(typeof result, "boolean");
  });
  it("countTokens returns a positive number for non-empty text", async () => {
    const count = await countTokens("The quick brown fox jumps over the lazy dog.");
    assert.ok(count > 0, "should return positive token count");
  });
  it("countTokens returns 0 for empty string", async () => {
    const count = await countTokens("");
    assert.equal(count, 0);
  });
  it("isAccurateCountingAvailable reflects encoder state", () => {
    const available = isAccurateCountingAvailable();
    assert.equal(typeof available, "boolean");
  });
  it("countTokensSync gives accurate count after init", async () => {
    await initTokenCounter();
    if (isAccurateCountingAvailable()) {
      const syncCount = countTokensSync("hello world");
      const asyncCount = await countTokens("hello world");
      assert.equal(syncCount, asyncCount, "sync and async should match after init");
    }
  });
  it("token count is more accurate than chars/4 for code", async () => {
    await initTokenCounter();
    if (isAccurateCountingAvailable()) {
      const code = "function add(a: number, b: number): number { return a + b; }";
      const tokens = await countTokens(code);
      const heuristic = Math.ceil(code.length / 4);
      assert.ok(tokens !== heuristic, "tiktoken count should differ from simple heuristic for code");
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL3Rva2VuLWNvdW50ZXIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIGl0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQge1xuXHRjb3VudFRva2Vucyxcblx0Y291bnRUb2tlbnNTeW5jLFxuXHRpbml0VG9rZW5Db3VudGVyLFxuXHRpc0FjY3VyYXRlQ291bnRpbmdBdmFpbGFibGUsXG59IGZyb20gXCIuLi9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvdG9rZW4tY291bnRlci50c1wiO1xuXG5kZXNjcmliZShcInRva2VuLWNvdW50ZXJcIiwgKCkgPT4ge1xuXHRpdChcImNvdW50VG9rZW5zU3luYyByZXR1cm5zIGhldXJpc3RpYyBlc3RpbWF0ZSBiZWZvcmUgaW5pdFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY291bnQgPSBjb3VudFRva2Vuc1N5bmMoXCJoZWxsbyB3b3JsZFwiKTtcblx0XHRhc3NlcnQuZXF1YWwoY291bnQsIE1hdGguY2VpbChcImhlbGxvIHdvcmxkXCIubGVuZ3RoIC8gNCkpO1xuXHR9KTtcblxuXHRpdChcImluaXRUb2tlbkNvdW50ZXIgaW5pdGlhbGl6ZXMgdGhlIGVuY29kZXJcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IGluaXRUb2tlbkNvdW50ZXIoKTtcblx0XHRhc3NlcnQuZXF1YWwodHlwZW9mIHJlc3VsdCwgXCJib29sZWFuXCIpO1xuXHR9KTtcblxuXHRpdChcImNvdW50VG9rZW5zIHJldHVybnMgYSBwb3NpdGl2ZSBudW1iZXIgZm9yIG5vbi1lbXB0eSB0ZXh0XCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBjb3VudCA9IGF3YWl0IGNvdW50VG9rZW5zKFwiVGhlIHF1aWNrIGJyb3duIGZveCBqdW1wcyBvdmVyIHRoZSBsYXp5IGRvZy5cIik7XG5cdFx0YXNzZXJ0Lm9rKGNvdW50ID4gMCwgXCJzaG91bGQgcmV0dXJuIHBvc2l0aXZlIHRva2VuIGNvdW50XCIpO1xuXHR9KTtcblxuXHRpdChcImNvdW50VG9rZW5zIHJldHVybnMgMCBmb3IgZW1wdHkgc3RyaW5nXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBjb3VudCA9IGF3YWl0IGNvdW50VG9rZW5zKFwiXCIpO1xuXHRcdGFzc2VydC5lcXVhbChjb3VudCwgMCk7XG5cdH0pO1xuXG5cdGl0KFwiaXNBY2N1cmF0ZUNvdW50aW5nQXZhaWxhYmxlIHJlZmxlY3RzIGVuY29kZXIgc3RhdGVcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGF2YWlsYWJsZSA9IGlzQWNjdXJhdGVDb3VudGluZ0F2YWlsYWJsZSgpO1xuXHRcdGFzc2VydC5lcXVhbCh0eXBlb2YgYXZhaWxhYmxlLCBcImJvb2xlYW5cIik7XG5cdH0pO1xuXG5cdGl0KFwiY291bnRUb2tlbnNTeW5jIGdpdmVzIGFjY3VyYXRlIGNvdW50IGFmdGVyIGluaXRcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGF3YWl0IGluaXRUb2tlbkNvdW50ZXIoKTtcblx0XHRpZiAoaXNBY2N1cmF0ZUNvdW50aW5nQXZhaWxhYmxlKCkpIHtcblx0XHRcdGNvbnN0IHN5bmNDb3VudCA9IGNvdW50VG9rZW5zU3luYyhcImhlbGxvIHdvcmxkXCIpO1xuXHRcdFx0Y29uc3QgYXN5bmNDb3VudCA9IGF3YWl0IGNvdW50VG9rZW5zKFwiaGVsbG8gd29ybGRcIik7XG5cdFx0XHRhc3NlcnQuZXF1YWwoc3luY0NvdW50LCBhc3luY0NvdW50LCBcInN5bmMgYW5kIGFzeW5jIHNob3VsZCBtYXRjaCBhZnRlciBpbml0XCIpO1xuXHRcdH1cblx0fSk7XG5cblx0aXQoXCJ0b2tlbiBjb3VudCBpcyBtb3JlIGFjY3VyYXRlIHRoYW4gY2hhcnMvNCBmb3IgY29kZVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0YXdhaXQgaW5pdFRva2VuQ291bnRlcigpO1xuXHRcdGlmIChpc0FjY3VyYXRlQ291bnRpbmdBdmFpbGFibGUoKSkge1xuXHRcdFx0Y29uc3QgY29kZSA9ICdmdW5jdGlvbiBhZGQoYTogbnVtYmVyLCBiOiBudW1iZXIpOiBudW1iZXIgeyByZXR1cm4gYSArIGI7IH0nO1xuXHRcdFx0Y29uc3QgdG9rZW5zID0gYXdhaXQgY291bnRUb2tlbnMoY29kZSk7XG5cdFx0XHRjb25zdCBoZXVyaXN0aWMgPSBNYXRoLmNlaWwoY29kZS5sZW5ndGggLyA0KTtcblx0XHRcdGFzc2VydC5vayh0b2tlbnMgIT09IGhldXJpc3RpYywgXCJ0aWt0b2tlbiBjb3VudCBzaG91bGQgZGlmZmVyIGZyb20gc2ltcGxlIGhldXJpc3RpYyBmb3IgY29kZVwiKTtcblx0XHR9XG5cdH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLFVBQVUsVUFBVTtBQUM3QixPQUFPLFlBQVk7QUFDbkI7QUFBQSxFQUNDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDTTtBQUVQLFNBQVMsaUJBQWlCLE1BQU07QUFDL0IsS0FBRywwREFBMEQsTUFBTTtBQUNsRSxVQUFNLFFBQVEsZ0JBQWdCLGFBQWE7QUFDM0MsV0FBTyxNQUFNLE9BQU8sS0FBSyxLQUFLLGNBQWMsU0FBUyxDQUFDLENBQUM7QUFBQSxFQUN4RCxDQUFDO0FBRUQsS0FBRyw0Q0FBNEMsWUFBWTtBQUMxRCxVQUFNLFNBQVMsTUFBTSxpQkFBaUI7QUFDdEMsV0FBTyxNQUFNLE9BQU8sUUFBUSxTQUFTO0FBQUEsRUFDdEMsQ0FBQztBQUVELEtBQUcsNERBQTRELFlBQVk7QUFDMUUsVUFBTSxRQUFRLE1BQU0sWUFBWSw4Q0FBOEM7QUFDOUUsV0FBTyxHQUFHLFFBQVEsR0FBRyxvQ0FBb0M7QUFBQSxFQUMxRCxDQUFDO0FBRUQsS0FBRywwQ0FBMEMsWUFBWTtBQUN4RCxVQUFNLFFBQVEsTUFBTSxZQUFZLEVBQUU7QUFDbEMsV0FBTyxNQUFNLE9BQU8sQ0FBQztBQUFBLEVBQ3RCLENBQUM7QUFFRCxLQUFHLHNEQUFzRCxNQUFNO0FBQzlELFVBQU0sWUFBWSw0QkFBNEI7QUFDOUMsV0FBTyxNQUFNLE9BQU8sV0FBVyxTQUFTO0FBQUEsRUFDekMsQ0FBQztBQUVELEtBQUcsbURBQW1ELFlBQVk7QUFDakUsVUFBTSxpQkFBaUI7QUFDdkIsUUFBSSw0QkFBNEIsR0FBRztBQUNsQyxZQUFNLFlBQVksZ0JBQWdCLGFBQWE7QUFDL0MsWUFBTSxhQUFhLE1BQU0sWUFBWSxhQUFhO0FBQ2xELGFBQU8sTUFBTSxXQUFXLFlBQVksd0NBQXdDO0FBQUEsSUFDN0U7QUFBQSxFQUNELENBQUM7QUFFRCxLQUFHLHNEQUFzRCxZQUFZO0FBQ3BFLFVBQU0saUJBQWlCO0FBQ3ZCLFFBQUksNEJBQTRCLEdBQUc7QUFDbEMsWUFBTSxPQUFPO0FBQ2IsWUFBTSxTQUFTLE1BQU0sWUFBWSxJQUFJO0FBQ3JDLFlBQU0sWUFBWSxLQUFLLEtBQUssS0FBSyxTQUFTLENBQUM7QUFDM0MsYUFBTyxHQUFHLFdBQVcsV0FBVyw2REFBNkQ7QUFBQSxJQUM5RjtBQUFBLEVBQ0QsQ0FBQztBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
