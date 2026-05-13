import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { normalizePythonCommand, detectPythonExecutable } from "../python-resolver.js";
describe("normalizePythonCommand", () => {
  test("passes through command that does not start with python", () => {
    assert.equal(normalizePythonCommand("npm run test"), "npm run test");
  });
  test("passes through empty string", () => {
    assert.equal(normalizePythonCommand(""), "");
  });
  test("passes through non-python shell commands unchanged", () => {
    assert.equal(normalizePythonCommand("node index.js"), "node index.js");
    assert.equal(normalizePythonCommand("npx tsc --noEmit"), "npx tsc --noEmit");
  });
  test("passes through command unchanged when no python is detected", () => {
    const cmd = "cargo test";
    assert.equal(normalizePythonCommand(cmd), cmd);
  });
  test("rewrites leading python3 token when interpreter is detected", () => {
    const input = "python3 -m pytest";
    const result = normalizePythonCommand(input);
    const detected = detectPythonExecutable();
    if (detected === null) {
      assert.equal(result, input, "expected passthrough when no interpreter is detected");
      return;
    }
    assert.ok(
      result.startsWith(`${detected} `),
      `Expected rewritten prefix '${detected} ' in: ${result}`
    );
    assert.ok(result.includes("-m pytest"), `Expected arguments preserved in: ${result}`);
  });
  test("rewrites leading python token when interpreter is detected", () => {
    const input = "python manage.py migrate";
    const result = normalizePythonCommand(input);
    const detected = detectPythonExecutable();
    if (detected === null) {
      assert.equal(result, input, "expected passthrough when no interpreter is detected");
      return;
    }
    assert.ok(
      result.startsWith(`${detected} `),
      `Expected rewritten prefix '${detected} ' in: ${result}`
    );
    assert.ok(result.includes("manage.py migrate"), `Expected arguments preserved in: ${result}`);
  });
  test("rewrites python token after && compound separator", () => {
    const input = "echo ok && python3 -m pytest --tb=short";
    const result = normalizePythonCommand(input);
    const detected = detectPythonExecutable();
    if (detected === null) {
      assert.equal(result, input, "expected passthrough when no interpreter is detected");
      return;
    }
    assert.ok(
      result.includes(`&& ${detected} `),
      `Expected '&& ${detected} ' segment in: ${result}`
    );
    assert.ok(
      result.includes("-m pytest --tb=short"),
      `Expected arguments preserved in: ${result}`
    );
  });
  test("rewrites leading python token when command has leading whitespace", () => {
    const input = "  python3 -m pytest";
    const result = normalizePythonCommand(input);
    const detected = detectPythonExecutable();
    if (detected === null) {
      assert.equal(result, input, "expected passthrough when no interpreter is detected");
      return;
    }
    assert.equal(
      result,
      `  ${detected} -m pytest`,
      `Expected leading whitespace preserved and python3 rewritten in: ${result}`
    );
  });
  test("does not duplicate '-3' when rewriting existing 'py -3' token", () => {
    const input = "py -3 -m pytest";
    const result = normalizePythonCommand(input);
    const detected = detectPythonExecutable();
    if (detected === null) {
      assert.equal(result, input, "expected passthrough when no interpreter is detected");
      return;
    }
    assert.equal(
      result,
      `${detected} -m pytest`,
      `Expected clean rewrite without duplicated '-3' in: ${result}`
    );
  });
});
describe("detectPythonExecutable", () => {
  test("returns a string or null \u2014 never throws", () => {
    let result;
    assert.doesNotThrow(() => {
      result = detectPythonExecutable();
    });
    assert.ok(result === null || typeof result === "string");
  });
  test("return value is a known python invocation form or null", () => {
    const result = detectPythonExecutable();
    const valid = [null, "python3", "python", "py -3"];
    assert.ok(
      valid.includes(result),
      `Expected one of ${valid.join(", ")}, got: ${String(result)}`
    );
  });
  test("returns the same value on repeated calls (cached)", () => {
    const first = detectPythonExecutable();
    const second = detectPythonExecutable();
    assert.equal(first, second, "detectPythonExecutable must return consistent cached result");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9weXRob24tcmVzb2x2ZXIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcblxuLy8gUmVncmVzc2lvbiB0ZXN0cyBmb3IgIzQ0MTY6IHB5dGhvbiBpbnZvY2F0aW9uIG5vcm1hbGl6YXRpb24gZm9yIFdpbmRvd3MuXG4vLyBUaGVzZSB0ZXN0cyBpbXBvcnQgZnJvbSBweXRob24tcmVzb2x2ZXIudHMgd2hpY2ggaXMgY3JlYXRlZCBhcyBwYXJ0IG9mIHRoZSBmaXguXG5pbXBvcnQgeyBub3JtYWxpemVQeXRob25Db21tYW5kLCBkZXRlY3RQeXRob25FeGVjdXRhYmxlIH0gZnJvbSBcIi4uL3B5dGhvbi1yZXNvbHZlci50c1wiO1xuXG5kZXNjcmliZShcIm5vcm1hbGl6ZVB5dGhvbkNvbW1hbmRcIiwgKCkgPT4ge1xuICB0ZXN0KFwicGFzc2VzIHRocm91Z2ggY29tbWFuZCB0aGF0IGRvZXMgbm90IHN0YXJ0IHdpdGggcHl0aG9uXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwobm9ybWFsaXplUHl0aG9uQ29tbWFuZChcIm5wbSBydW4gdGVzdFwiKSwgXCJucG0gcnVuIHRlc3RcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJwYXNzZXMgdGhyb3VnaCBlbXB0eSBzdHJpbmdcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChub3JtYWxpemVQeXRob25Db21tYW5kKFwiXCIpLCBcIlwiKTtcbiAgfSk7XG5cbiAgdGVzdChcInBhc3NlcyB0aHJvdWdoIG5vbi1weXRob24gc2hlbGwgY29tbWFuZHMgdW5jaGFuZ2VkXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwobm9ybWFsaXplUHl0aG9uQ29tbWFuZChcIm5vZGUgaW5kZXguanNcIiksIFwibm9kZSBpbmRleC5qc1wiKTtcbiAgICBhc3NlcnQuZXF1YWwobm9ybWFsaXplUHl0aG9uQ29tbWFuZChcIm5weCB0c2MgLS1ub0VtaXRcIiksIFwibnB4IHRzYyAtLW5vRW1pdFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcInBhc3NlcyB0aHJvdWdoIGNvbW1hbmQgdW5jaGFuZ2VkIHdoZW4gbm8gcHl0aG9uIGlzIGRldGVjdGVkXCIsICgpID0+IHtcbiAgICAvLyBXZSBjYW5ub3QgZnVsbHkgbW9jayBkZXRlY3RQeXRob25FeGVjdXRhYmxlIGhlcmUgd2l0aG91dCBhIG1vY2sgZnJhbWV3b3JrLFxuICAgIC8vIGJ1dCB3ZSBjYW4gdmVyaWZ5IHRoYXQgYSBjb21tYW5kIHdpdGhvdXQgcHl0aG9uIHRva2VucyBpcyBhbHdheXMgcHJlc2VydmVkLlxuICAgIGNvbnN0IGNtZCA9IFwiY2FyZ28gdGVzdFwiO1xuICAgIGFzc2VydC5lcXVhbChub3JtYWxpemVQeXRob25Db21tYW5kKGNtZCksIGNtZCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXdyaXRlcyBsZWFkaW5nIHB5dGhvbjMgdG9rZW4gd2hlbiBpbnRlcnByZXRlciBpcyBkZXRlY3RlZFwiLCAoKSA9PiB7XG4gICAgY29uc3QgaW5wdXQgPSBcInB5dGhvbjMgLW0gcHl0ZXN0XCI7XG4gICAgY29uc3QgcmVzdWx0ID0gbm9ybWFsaXplUHl0aG9uQ29tbWFuZChpbnB1dCk7XG4gICAgY29uc3QgZGV0ZWN0ZWQgPSBkZXRlY3RQeXRob25FeGVjdXRhYmxlKCk7XG4gICAgaWYgKGRldGVjdGVkID09PSBudWxsKSB7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBpbnB1dCwgXCJleHBlY3RlZCBwYXNzdGhyb3VnaCB3aGVuIG5vIGludGVycHJldGVyIGlzIGRldGVjdGVkXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBhc3NlcnQub2soXG4gICAgICByZXN1bHQuc3RhcnRzV2l0aChgJHtkZXRlY3RlZH0gYCksXG4gICAgICBgRXhwZWN0ZWQgcmV3cml0dGVuIHByZWZpeCAnJHtkZXRlY3RlZH0gJyBpbjogJHtyZXN1bHR9YCxcbiAgICApO1xuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCItbSBweXRlc3RcIiksIGBFeHBlY3RlZCBhcmd1bWVudHMgcHJlc2VydmVkIGluOiAke3Jlc3VsdH1gKTtcbiAgfSk7XG5cbiAgdGVzdChcInJld3JpdGVzIGxlYWRpbmcgcHl0aG9uIHRva2VuIHdoZW4gaW50ZXJwcmV0ZXIgaXMgZGV0ZWN0ZWRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGlucHV0ID0gXCJweXRob24gbWFuYWdlLnB5IG1pZ3JhdGVcIjtcbiAgICBjb25zdCByZXN1bHQgPSBub3JtYWxpemVQeXRob25Db21tYW5kKGlucHV0KTtcbiAgICBjb25zdCBkZXRlY3RlZCA9IGRldGVjdFB5dGhvbkV4ZWN1dGFibGUoKTtcbiAgICBpZiAoZGV0ZWN0ZWQgPT09IG51bGwpIHtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIGlucHV0LCBcImV4cGVjdGVkIHBhc3N0aHJvdWdoIHdoZW4gbm8gaW50ZXJwcmV0ZXIgaXMgZGV0ZWN0ZWRcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGFzc2VydC5vayhcbiAgICAgIHJlc3VsdC5zdGFydHNXaXRoKGAke2RldGVjdGVkfSBgKSxcbiAgICAgIGBFeHBlY3RlZCByZXdyaXR0ZW4gcHJlZml4ICcke2RldGVjdGVkfSAnIGluOiAke3Jlc3VsdH1gLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcIm1hbmFnZS5weSBtaWdyYXRlXCIpLCBgRXhwZWN0ZWQgYXJndW1lbnRzIHByZXNlcnZlZCBpbjogJHtyZXN1bHR9YCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXdyaXRlcyBweXRob24gdG9rZW4gYWZ0ZXIgJiYgY29tcG91bmQgc2VwYXJhdG9yXCIsICgpID0+IHtcbiAgICBjb25zdCBpbnB1dCA9IFwiZWNobyBvayAmJiBweXRob24zIC1tIHB5dGVzdCAtLXRiPXNob3J0XCI7XG4gICAgY29uc3QgcmVzdWx0ID0gbm9ybWFsaXplUHl0aG9uQ29tbWFuZChpbnB1dCk7XG4gICAgY29uc3QgZGV0ZWN0ZWQgPSBkZXRlY3RQeXRob25FeGVjdXRhYmxlKCk7XG4gICAgaWYgKGRldGVjdGVkID09PSBudWxsKSB7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBpbnB1dCwgXCJleHBlY3RlZCBwYXNzdGhyb3VnaCB3aGVuIG5vIGludGVycHJldGVyIGlzIGRldGVjdGVkXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBhc3NlcnQub2soXG4gICAgICByZXN1bHQuaW5jbHVkZXMoYCYmICR7ZGV0ZWN0ZWR9IGApLFxuICAgICAgYEV4cGVjdGVkICcmJiAke2RldGVjdGVkfSAnIHNlZ21lbnQgaW46ICR7cmVzdWx0fWAsXG4gICAgKTtcbiAgICBhc3NlcnQub2soXG4gICAgICByZXN1bHQuaW5jbHVkZXMoXCItbSBweXRlc3QgLS10Yj1zaG9ydFwiKSxcbiAgICAgIGBFeHBlY3RlZCBhcmd1bWVudHMgcHJlc2VydmVkIGluOiAke3Jlc3VsdH1gLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXdyaXRlcyBsZWFkaW5nIHB5dGhvbiB0b2tlbiB3aGVuIGNvbW1hbmQgaGFzIGxlYWRpbmcgd2hpdGVzcGFjZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgaW5wdXQgPSBcIiAgcHl0aG9uMyAtbSBweXRlc3RcIjtcbiAgICBjb25zdCByZXN1bHQgPSBub3JtYWxpemVQeXRob25Db21tYW5kKGlucHV0KTtcbiAgICBjb25zdCBkZXRlY3RlZCA9IGRldGVjdFB5dGhvbkV4ZWN1dGFibGUoKTtcbiAgICBpZiAoZGV0ZWN0ZWQgPT09IG51bGwpIHtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIGlucHV0LCBcImV4cGVjdGVkIHBhc3N0aHJvdWdoIHdoZW4gbm8gaW50ZXJwcmV0ZXIgaXMgZGV0ZWN0ZWRcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHJlc3VsdCxcbiAgICAgIGAgICR7ZGV0ZWN0ZWR9IC1tIHB5dGVzdGAsXG4gICAgICBgRXhwZWN0ZWQgbGVhZGluZyB3aGl0ZXNwYWNlIHByZXNlcnZlZCBhbmQgcHl0aG9uMyByZXdyaXR0ZW4gaW46ICR7cmVzdWx0fWAsXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcImRvZXMgbm90IGR1cGxpY2F0ZSAnLTMnIHdoZW4gcmV3cml0aW5nIGV4aXN0aW5nICdweSAtMycgdG9rZW5cIiwgKCkgPT4ge1xuICAgIGNvbnN0IGlucHV0ID0gXCJweSAtMyAtbSBweXRlc3RcIjtcbiAgICBjb25zdCByZXN1bHQgPSBub3JtYWxpemVQeXRob25Db21tYW5kKGlucHV0KTtcbiAgICBjb25zdCBkZXRlY3RlZCA9IGRldGVjdFB5dGhvbkV4ZWN1dGFibGUoKTtcbiAgICBpZiAoZGV0ZWN0ZWQgPT09IG51bGwpIHtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIGlucHV0LCBcImV4cGVjdGVkIHBhc3N0aHJvdWdoIHdoZW4gbm8gaW50ZXJwcmV0ZXIgaXMgZGV0ZWN0ZWRcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHJlc3VsdCxcbiAgICAgIGAke2RldGVjdGVkfSAtbSBweXRlc3RgLFxuICAgICAgYEV4cGVjdGVkIGNsZWFuIHJld3JpdGUgd2l0aG91dCBkdXBsaWNhdGVkICctMycgaW46ICR7cmVzdWx0fWAsXG4gICAgKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJkZXRlY3RQeXRob25FeGVjdXRhYmxlXCIsICgpID0+IHtcbiAgdGVzdChcInJldHVybnMgYSBzdHJpbmcgb3IgbnVsbCBcdTIwMTQgbmV2ZXIgdGhyb3dzXCIsICgpID0+IHtcbiAgICBsZXQgcmVzdWx0OiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkO1xuICAgIGFzc2VydC5kb2VzTm90VGhyb3coKCkgPT4ge1xuICAgICAgcmVzdWx0ID0gZGV0ZWN0UHl0aG9uRXhlY3V0YWJsZSgpO1xuICAgIH0pO1xuICAgIGFzc2VydC5vayhyZXN1bHQgPT09IG51bGwgfHwgdHlwZW9mIHJlc3VsdCA9PT0gXCJzdHJpbmdcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXR1cm4gdmFsdWUgaXMgYSBrbm93biBweXRob24gaW52b2NhdGlvbiBmb3JtIG9yIG51bGxcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGRldGVjdFB5dGhvbkV4ZWN1dGFibGUoKTtcbiAgICBjb25zdCB2YWxpZCA9IFtudWxsLCBcInB5dGhvbjNcIiwgXCJweXRob25cIiwgXCJweSAtM1wiXTtcbiAgICBhc3NlcnQub2soXG4gICAgICB2YWxpZC5pbmNsdWRlcyhyZXN1bHQgYXMgc3RyaW5nIHwgbnVsbCksXG4gICAgICBgRXhwZWN0ZWQgb25lIG9mICR7dmFsaWQuam9pbihcIiwgXCIpfSwgZ290OiAke1N0cmluZyhyZXN1bHQpfWAsXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgdGhlIHNhbWUgdmFsdWUgb24gcmVwZWF0ZWQgY2FsbHMgKGNhY2hlZClcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGZpcnN0ID0gZGV0ZWN0UHl0aG9uRXhlY3V0YWJsZSgpO1xuICAgIGNvbnN0IHNlY29uZCA9IGRldGVjdFB5dGhvbkV4ZWN1dGFibGUoKTtcbiAgICBhc3NlcnQuZXF1YWwoZmlyc3QsIHNlY29uZCwgXCJkZXRlY3RQeXRob25FeGVjdXRhYmxlIG11c3QgcmV0dXJuIGNvbnNpc3RlbnQgY2FjaGVkIHJlc3VsdFwiKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsVUFBVSxZQUFZO0FBQy9CLE9BQU8sWUFBWTtBQUluQixTQUFTLHdCQUF3Qiw4QkFBOEI7QUFFL0QsU0FBUywwQkFBMEIsTUFBTTtBQUN2QyxPQUFLLDBEQUEwRCxNQUFNO0FBQ25FLFdBQU8sTUFBTSx1QkFB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
