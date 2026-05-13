import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { extractTrace } from "../session-forensics.js";
function makeToolPair(toolName, input, resultText, isError) {
  const toolCallId = `toolu_${Math.random().toString(36).slice(2, 10)}`;
  return [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: toolName,
            arguments: input
          }
        ]
      }
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId,
        toolName,
        isError,
        content: [{ type: "text", text: resultText }]
      }
    }
  ];
}
describe("extractTrace error filtering (#2539)", () => {
  test("grep exit-code-1 (no matches) is not counted as an error", () => {
    const entries = makeToolPair(
      "bash",
      { command: "grep -rn 'nonexistent' src/" },
      "(no output)\nCommand exited with code 1",
      true
    );
    const trace = extractTrace(entries);
    assert.equal(trace.errors.length, 0, "grep no-match should not be an error");
  });
  test("user skip is not counted as an error", () => {
    const entries = makeToolPair(
      "bash",
      { command: "npm run test" },
      "Skipped due to queued user message",
      true
    );
    const trace = extractTrace(entries);
    assert.equal(trace.errors.length, 0, "user skip should not be an error");
  });
  test("real bash error is still counted", () => {
    const entries = makeToolPair(
      "bash",
      { command: "cat /nonexistent" },
      "cat: /nonexistent: No such file or directory\nCommand exited with code 1",
      true
    );
    const trace = extractTrace(entries);
    assert.equal(trace.errors.length, 1, "real error should still be counted");
    assert.match(trace.errors[0], /No such file or directory/);
  });
  test("non-bash tool error is still counted", () => {
    const entries = makeToolPair(
      "edit",
      { path: "foo.ts", oldText: "x", newText: "y" },
      "oldText not found in file",
      true
    );
    const trace = extractTrace(entries);
    assert.equal(trace.errors.length, 1, "non-bash tool errors should still be counted");
  });
  test("mixed entries: only real errors are counted", () => {
    const entries = [
      // benign grep no-match
      ...makeToolPair("bash", { command: "grep -rn 'pattern' src/" }, "(no output)\nCommand exited with code 1", true),
      // user skip
      ...makeToolPair("bash", { command: "npm test" }, "Skipped due to queued user message", true),
      // real error
      ...makeToolPair("bash", { command: "node broken.js" }, "SyntaxError: Unexpected token\nCommand exited with code 1", true),
      // successful command (not an error)
      ...makeToolPair("bash", { command: "echo hello" }, "hello", false)
    ];
    const trace = extractTrace(entries);
    assert.equal(trace.errors.length, 1, "only the real error should be counted");
    assert.match(trace.errors[0], /SyntaxError/);
  });
  test("exit code 1 with actual output is still an error", () => {
    const entries = makeToolPair(
      "bash",
      { command: "npm run lint" },
      "src/foo.ts:10:5 - error TS2304: Cannot find name 'x'\nCommand exited with code 1",
      true
    );
    const trace = extractTrace(entries);
    assert.equal(trace.errors.length, 1, "lint error with output should be counted");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9mb3JlbnNpY3MtZXJyb3ItZmlsdGVyLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUmVncmVzc2lvbiB0ZXN0IGZvciAjMjUzOTogZXh0cmFjdFRyYWNlIHNob3VsZCBub3QgY291bnQgYmVuaWduIGJhc2hcbiAqIGV4aXQtY29kZS0xIChncmVwIG5vLW1hdGNoKSBvciB1c2VyIHNraXBzIGFzIGVycm9ycy5cbiAqL1xuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcblxuaW1wb3J0IHsgZXh0cmFjdFRyYWNlIH0gZnJvbSBcIi4uL3Nlc3Npb24tZm9yZW5zaWNzLnRzXCI7XG5cbi8qKlxuICogQnVpbGQgYSBtaW5pbWFsIEpTT05MIGVudHJ5IHBhaXI6IGFzc2lzdGFudCB0b29sX3VzZSBcdTIxOTIgdG9vbFJlc3VsdC5cbiAqIFRoaXMgaXMgdGhlIHNoYXBlIGV4dHJhY3RUcmFjZSgpIGV4cGVjdHMgZnJvbSBzZXNzaW9uIGFjdGl2aXR5IGZpbGVzLlxuICovXG5mdW5jdGlvbiBtYWtlVG9vbFBhaXIoXG4gIHRvb2xOYW1lOiBzdHJpbmcsXG4gIGlucHV0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgcmVzdWx0VGV4dDogc3RyaW5nLFxuICBpc0Vycm9yOiBib29sZWFuLFxuKTogdW5rbm93bltdIHtcbiAgY29uc3QgdG9vbENhbGxJZCA9IGB0b29sdV8ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDEwKX1gO1xuICByZXR1cm4gW1xuICAgIHtcbiAgICAgIHR5cGU6IFwibWVzc2FnZVwiLFxuICAgICAgbWVzc2FnZToge1xuICAgICAgICByb2xlOiBcImFzc2lzdGFudFwiLFxuICAgICAgICBjb250ZW50OiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgdHlwZTogXCJ0b29sQ2FsbFwiLFxuICAgICAgICAgICAgaWQ6IHRvb2xDYWxsSWQsXG4gICAgICAgICAgICBuYW1lOiB0b29sTmFtZSxcbiAgICAgICAgICAgIGFyZ3VtZW50czogaW5wdXQsXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICB0eXBlOiBcIm1lc3NhZ2VcIixcbiAgICAgIG1lc3NhZ2U6IHtcbiAgICAgICAgcm9sZTogXCJ0b29sUmVzdWx0XCIsXG4gICAgICAgIHRvb2xDYWxsSWQsXG4gICAgICAgIHRvb2xOYW1lLFxuICAgICAgICBpc0Vycm9yLFxuICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogcmVzdWx0VGV4dCB9XSxcbiAgICAgIH0sXG4gICAgfSxcbiAgXTtcbn1cblxuZGVzY3JpYmUoXCJleHRyYWN0VHJhY2UgZXJyb3IgZmlsdGVyaW5nICgjMjUzOSlcIiwgKCkgPT4ge1xuICB0ZXN0KFwiZ3JlcCBleGl0LWNvZGUtMSAobm8gbWF0Y2hlcykgaXMgbm90IGNvdW50ZWQgYXMgYW4gZXJyb3JcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGVudHJpZXMgPSBtYWtlVG9vbFBhaXIoXG4gICAgICBcImJhc2hcIixcbiAgICAgIHsgY29tbWFuZDogXCJncmVwIC1ybiAnbm9uZXhpc3RlbnQnIHNyYy9cIiB9LFxuICAgICAgXCIobm8gb3V0cHV0KVxcbkNvbW1hbmQgZXhpdGVkIHdpdGggY29kZSAxXCIsXG4gICAgICB0cnVlLFxuICAgICk7XG4gICAgY29uc3QgdHJhY2UgPSBleHRyYWN0VHJhY2UoZW50cmllcyk7XG4gICAgYXNzZXJ0LmVxdWFsKHRyYWNlLmVycm9ycy5sZW5ndGgsIDAsIFwiZ3JlcCBuby1tYXRjaCBzaG91bGQgbm90IGJlIGFuIGVycm9yXCIpO1xuICB9KTtcblxuICB0ZXN0KFwidXNlciBza2lwIGlzIG5vdCBjb3VudGVkIGFzIGFuIGVycm9yXCIsICgpID0+IHtcbiAgICBjb25zdCBlbnRyaWVzID0gbWFrZVRvb2xQYWlyKFxuICAgICAgXCJiYXNoXCIsXG4gICAgICB7IGNvbW1hbmQ6IFwibnBtIHJ1biB0ZXN0XCIgfSxcbiAgICAgIFwiU2tpcHBlZCBkdWUgdG8gcXVldWVkIHVzZXIgbWVzc2FnZVwiLFxuICAgICAgdHJ1ZSxcbiAgICApO1xuICAgIGNvbnN0IHRyYWNlID0gZXh0cmFjdFRyYWNlKGVudHJpZXMpO1xuICAgIGFzc2VydC5lcXVhbCh0cmFjZS5lcnJvcnMubGVuZ3RoLCAwLCBcInVzZXIgc2tpcCBzaG91bGQgbm90IGJlIGFuIGVycm9yXCIpO1xuICB9KTtcblxuICB0ZXN0KFwicmVhbCBiYXNoIGVycm9yIGlzIHN0aWxsIGNvdW50ZWRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGVudHJpZXMgPSBtYWtlVG9vbFBhaXIoXG4gICAgICBcImJhc2hcIixcbiAgICAgIHsgY29tbWFuZDogXCJjYXQgL25vbmV4aXN0ZW50XCIgfSxcbiAgICAgIFwiY2F0OiAvbm9uZXhpc3RlbnQ6IE5vIHN1Y2ggZmlsZSBvciBkaXJlY3RvcnlcXG5Db21tYW5kIGV4aXRlZCB3aXRoIGNvZGUgMVwiLFxuICAgICAgdHJ1ZSxcbiAgICApO1xuICAgIGNvbnN0IHRyYWNlID0gZXh0cmFjdFRyYWNlKGVudHJpZXMpO1xuICAgIGFzc2VydC5lcXVhbCh0cmFjZS5lcnJvcnMubGVuZ3RoLCAxLCBcInJlYWwgZXJyb3Igc2hvdWxkIHN0aWxsIGJlIGNvdW50ZWRcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKHRyYWNlLmVycm9yc1swXSwgL05vIHN1Y2ggZmlsZSBvciBkaXJlY3RvcnkvKTtcbiAgfSk7XG5cbiAgdGVzdChcIm5vbi1iYXNoIHRvb2wgZXJyb3IgaXMgc3RpbGwgY291bnRlZFwiLCAoKSA9PiB7XG4gICAgY29uc3QgZW50cmllcyA9IG1ha2VUb29sUGFpcihcbiAgICAgIFwiZWRpdFwiLFxuICAgICAgeyBwYXRoOiBcImZvby50c1wiLCBvbGRUZXh0OiBcInhcIiwgbmV3VGV4dDogXCJ5XCIgfSxcbiAgICAgIFwib2xkVGV4dCBub3QgZm91bmQgaW4gZmlsZVwiLFxuICAgICAgdHJ1ZSxcbiAgICApO1xuICAgIGNvbnN0IHRyYWNlID0gZXh0cmFjdFRyYWNlKGVudHJpZXMpO1xuICAgIGFzc2VydC5lcXVhbCh0cmFjZS5lcnJvcnMubGVuZ3RoLCAxLCBcIm5vbi1iYXNoIHRvb2wgZXJyb3JzIHNob3VsZCBzdGlsbCBiZSBjb3VudGVkXCIpO1xuICB9KTtcblxuICB0ZXN0KFwibWl4ZWQgZW50cmllczogb25seSByZWFsIGVycm9ycyBhcmUgY291bnRlZFwiLCAoKSA9PiB7XG4gICAgY29uc3QgZW50cmllcyA9IFtcbiAgICAgIC8vIGJlbmlnbiBncmVwIG5vLW1hdGNoXG4gICAgICAuLi5tYWtlVG9vbFBhaXIoXCJiYXNoXCIsIHsgY29tbWFuZDogXCJncmVwIC1ybiAncGF0dGVybicgc3JjL1wiIH0sIFwiKG5vIG91dHB1dClcXG5Db21tYW5kIGV4aXRlZCB3aXRoIGNvZGUgMVwiLCB0cnVlKSxcbiAgICAgIC8vIHVzZXIgc2tpcFxuICAgICAgLi4ubWFrZVRvb2xQYWlyKFwiYmFzaFwiLCB7IGNvbW1hbmQ6IFwibnBtIHRlc3RcIiB9LCBcIlNraXBwZWQgZHVlIHRvIHF1ZXVlZCB1c2VyIG1lc3NhZ2VcIiwgdHJ1ZSksXG4gICAgICAvLyByZWFsIGVycm9yXG4gICAgICAuLi5tYWtlVG9vbFBhaXIoXCJiYXNoXCIsIHsgY29tbWFuZDogXCJub2RlIGJyb2tlbi5qc1wiIH0sIFwiU3ludGF4RXJyb3I6IFVuZXhwZWN0ZWQgdG9rZW5cXG5Db21tYW5kIGV4aXRlZCB3aXRoIGNvZGUgMVwiLCB0cnVlKSxcbiAgICAgIC8vIHN1Y2Nlc3NmdWwgY29tbWFuZCAobm90IGFuIGVycm9yKVxuICAgICAgLi4ubWFrZVRvb2xQYWlyKFwiYmFzaFwiLCB7IGNvbW1hbmQ6IFwiZWNobyBoZWxsb1wiIH0sIFwiaGVsbG9cIiwgZmFsc2UpLFxuICAgIF07XG4gICAgY29uc3QgdHJhY2UgPSBleHRyYWN0VHJhY2UoZW50cmllcyk7XG4gICAgYXNzZXJ0LmVxdWFsKHRyYWNlLmVycm9ycy5sZW5ndGgsIDEsIFwib25seSB0aGUgcmVhbCBlcnJvciBzaG91bGQgYmUgY291bnRlZFwiKTtcbiAgICBhc3NlcnQubWF0Y2godHJhY2UuZXJyb3JzWzBdLCAvU3ludGF4RXJyb3IvKTtcbiAgfSk7XG5cbiAgdGVzdChcImV4aXQgY29kZSAxIHdpdGggYWN0dWFsIG91dHB1dCBpcyBzdGlsbCBhbiBlcnJvclwiLCAoKSA9PiB7XG4gICAgY29uc3QgZW50cmllcyA9IG1ha2VUb29sUGFpcihcbiAgICAgIFwiYmFzaFwiLFxuICAgICAgeyBjb21tYW5kOiBcIm5wbSBydW4gbGludFwiIH0sXG4gICAgICBcInNyYy9mb28udHM6MTA6NSAtIGVycm9yIFRTMjMwNDogQ2Fubm90IGZpbmQgbmFtZSAneCdcXG5Db21tYW5kIGV4aXRlZCB3aXRoIGNvZGUgMVwiLFxuICAgICAgdHJ1ZSxcbiAgICApO1xuICAgIGNvbnN0IHRyYWNlID0gZXh0cmFjdFRyYWNlKGVudHJpZXMpO1xuICAgIGFzc2VydC5lcXVhbCh0cmFjZS5lcnJvcnMubGVuZ3RoLCAxLCBcImxpbnQgZXJyb3Igd2l0aCBvdXRwdXQgc2hvdWxkIGJlIGNvdW50ZWRcIik7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFJQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFFbkIsU0FBUyxvQkFBb0I7QUFNN0IsU0FBUyxhQUNQLFVBQ0EsT0FDQSxZQUNBLFNBQ1c7QUFDWCxRQUFNLGFBQWEsU0FBUyxLQUFLLE9BQU8sRUFBRSxTQUFTLEVBQUUsRUFBRSxNQUFNLEdBQUcsRUFBRSxDQUFDO0FBQ25FLFNBQU87QUFBQSxJQUNMO0FBQUEsTUFDRSxNQUFNO0FBQUEsTUFDTixTQUFTO0FBQUEsUUFDUCxNQUFNO0FBQUEsUUFDTixTQUFTO0FBQUEsVUFDUDtB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
