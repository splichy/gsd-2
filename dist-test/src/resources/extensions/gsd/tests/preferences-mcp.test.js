import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveModelMcpConfig } from "../preferences-mcp.js";
import { validatePreferences } from "../preferences-validation.js";
describe("resolveModelMcpConfig", () => {
  it("returns entry when modelId starts with configured prefix", () => {
    const config = {
      per_model: {
        "claude-haiku": { allowed_servers: ["a"] }
      }
    };
    const result = resolveModelMcpConfig("claude-haiku-4-5-20251001", config);
    assert.deepEqual(result, { allowed_servers: ["a"] });
  });
  it("longest-prefix-wins when multiple prefixes match", () => {
    const config = {
      per_model: {
        "claude-haiku": { allowed_servers: ["short"] },
        "claude-haiku-4-5": { allowed_servers: ["long"] }
      }
    };
    const result = resolveModelMcpConfig("claude-haiku-4-5-20251001", config);
    assert.deepEqual(result, { allowed_servers: ["long"] });
  });
  it("returns undefined when no prefix matches", () => {
    const config = {
      per_model: {
        "claude-haiku": { allowed_servers: ["a"] }
      }
    };
    const result = resolveModelMcpConfig("claude-opus-4-7", config);
    assert.equal(result, void 0);
  });
  it("returns undefined for empty per_model", () => {
    const config = { per_model: {} };
    const result = resolveModelMcpConfig("claude-sonnet-4-6", config);
    assert.equal(result, void 0);
  });
  it("returns entry when modelId exactly equals key", () => {
    const config = {
      per_model: {
        "claude-haiku-4-5-20251001": { blocked_servers: ["x"] }
      }
    };
    const result = resolveModelMcpConfig("claude-haiku-4-5-20251001", config);
    assert.deepEqual(result, { blocked_servers: ["x"] });
  });
  it("returns entry with both allowed_servers and blocked_servers", () => {
    const config = {
      per_model: {
        "claude-sonnet": { allowed_servers: ["a", "b"], blocked_servers: ["c"] }
      }
    };
    const result = resolveModelMcpConfig("claude-sonnet-4-6", config);
    assert.deepEqual(result, { allowed_servers: ["a", "b"], blocked_servers: ["c"] });
  });
});
describe("validatePreferences \u2014 claude_code_mcp", () => {
  it("passes with a valid claude_code_mcp block", () => {
    const { errors, warnings, preferences } = validatePreferences({
      claude_code_mcp: {
        per_model: {
          "claude-haiku": { allowed_servers: ["mcp-a"], blocked_servers: ["mcp-b"] }
        }
      }
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    assert.deepEqual(preferences.claude_code_mcp, {
      per_model: {
        "claude-haiku": { allowed_servers: ["mcp-a"], blocked_servers: ["mcp-b"] }
      }
    });
  });
  it("warns and ignores when claude_code_mcp is not an object", () => {
    const { errors, warnings } = validatePreferences({
      claude_code_mcp: "bad-value"
    });
    assert.deepEqual(errors, []);
    assert.ok(
      warnings.some((w) => w.includes("claude_code_mcp must be an object")),
      `expected warning about non-object, got: ${JSON.stringify(warnings)}`
    );
  });
  it("warns when per_model entry has non-array allowed_servers", () => {
    const { errors, warnings } = validatePreferences({
      claude_code_mcp: {
        per_model: {
          "claude-haiku": { allowed_servers: "not-an-array" }
        }
      }
    });
    assert.deepEqual(errors, []);
    assert.ok(
      warnings.some((w) => w.includes("allowed_servers")),
      `expected warning about allowed_servers, got: ${JSON.stringify(warnings)}`
    );
  });
  it("warns when per_model entry has non-array blocked_servers", () => {
    const { errors, warnings } = validatePreferences({
      claude_code_mcp: {
        per_model: {
          "claude-haiku": { blocked_servers: 42 }
        }
      }
    });
    assert.deepEqual(errors, []);
    assert.ok(
      warnings.some((w) => w.includes("blocked_servers")),
      `expected warning about blocked_servers, got: ${JSON.stringify(warnings)}`
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wcmVmZXJlbmNlcy1tY3AudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIGl0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyByZXNvbHZlTW9kZWxNY3BDb25maWcgfSBmcm9tIFwiLi4vcHJlZmVyZW5jZXMtbWNwLnRzXCI7XG5pbXBvcnQgeyB2YWxpZGF0ZVByZWZlcmVuY2VzIH0gZnJvbSBcIi4uL3ByZWZlcmVuY2VzLXZhbGlkYXRpb24udHNcIjtcbmltcG9ydCB0eXBlIHsgQ2xhdWRlQ29kZU1jcENvbmZpZyB9IGZyb20gXCIuLi9wcmVmZXJlbmNlcy10eXBlcy50c1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgcmVzb2x2ZU1vZGVsTWNwQ29uZmlnIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcInJlc29sdmVNb2RlbE1jcENvbmZpZ1wiLCAoKSA9PiB7XG4gIGl0KFwicmV0dXJucyBlbnRyeSB3aGVuIG1vZGVsSWQgc3RhcnRzIHdpdGggY29uZmlndXJlZCBwcmVmaXhcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvbmZpZzogQ2xhdWRlQ29kZU1jcENvbmZpZyA9IHtcbiAgICAgIHBlcl9tb2RlbDoge1xuICAgICAgICBcImNsYXVkZS1oYWlrdVwiOiB7IGFsbG93ZWRfc2VydmVyczogW1wiYVwiXSB9LFxuICAgICAgfSxcbiAgICB9O1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVNb2RlbE1jcENvbmZpZyhcImNsYXVkZS1oYWlrdS00LTUtMjAyNTEwMDFcIiwgY29uZmlnKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdCwgeyBhbGxvd2VkX3NlcnZlcnM6IFtcImFcIl0gfSk7XG4gIH0pO1xuXG4gIGl0KFwibG9uZ2VzdC1wcmVmaXgtd2lucyB3aGVuIG11bHRpcGxlIHByZWZpeGVzIG1hdGNoXCIsICgpID0+IHtcbiAgICBjb25zdCBjb25maWc6IENsYXVkZUNvZGVNY3BDb25maWcgPSB7XG4gICAgICBwZXJfbW9kZWw6IHtcbiAgICAgICAgXCJjbGF1ZGUtaGFpa3VcIjogeyBhbGxvd2VkX3NlcnZlcnM6IFtcInNob3J0XCJdIH0sXG4gICAgICAgIFwiY2xhdWRlLWhhaWt1LTQtNVwiOiB7IGFsbG93ZWRfc2VydmVyczogW1wibG9uZ1wiXSB9LFxuICAgICAgfSxcbiAgICB9O1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVNb2RlbE1jcENvbmZpZyhcImNsYXVkZS1oYWlrdS00LTUtMjAyNTEwMDFcIiwgY29uZmlnKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdCwgeyBhbGxvd2VkX3NlcnZlcnM6IFtcImxvbmdcIl0gfSk7XG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyB1bmRlZmluZWQgd2hlbiBubyBwcmVmaXggbWF0Y2hlc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgY29uZmlnOiBDbGF1ZGVDb2RlTWNwQ29uZmlnID0ge1xuICAgICAgcGVyX21vZGVsOiB7XG4gICAgICAgIFwiY2xhdWRlLWhhaWt1XCI6IHsgYWxsb3dlZF9zZXJ2ZXJzOiBbXCJhXCJdIH0sXG4gICAgICB9LFxuICAgIH07XG4gICAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZU1vZGVsTWNwQ29uZmlnKFwiY2xhdWRlLW9wdXMtNC03XCIsIGNvbmZpZyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgdW5kZWZpbmVkKTtcbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIHVuZGVmaW5lZCBmb3IgZW1wdHkgcGVyX21vZGVsXCIsICgpID0+IHtcbiAgICBjb25zdCBjb25maWc6IENsYXVkZUNvZGVNY3BDb25maWcgPSB7IHBlcl9tb2RlbDoge30gfTtcbiAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlTW9kZWxNY3BDb25maWcoXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCBjb25maWcpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIHVuZGVmaW5lZCk7XG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyBlbnRyeSB3aGVuIG1vZGVsSWQgZXhhY3RseSBlcXVhbHMga2V5XCIsICgpID0+IHtcbiAgICBjb25zdCBjb25maWc6IENsYXVkZUNvZGVNY3BDb25maWcgPSB7XG4gICAgICBwZXJfbW9kZWw6IHtcbiAgICAgICAgXCJjbGF1ZGUtaGFpa3UtNC01LTIwMjUxMDAxXCI6IHsgYmxvY2tlZF9zZXJ2ZXJzOiBbXCJ4XCJdIH0sXG4gICAgICB9LFxuICAgIH07XG4gICAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZU1vZGVsTWNwQ29uZmlnKFwiY2xhdWRlLWhhaWt1LTQtNS0yMDI1MTAwMVwiLCBjb25maWcpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LCB7IGJsb2NrZWRfc2VydmVyczogW1wieFwiXSB9KTtcbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIGVudHJ5IHdpdGggYm90aCBhbGxvd2VkX3NlcnZlcnMgYW5kIGJsb2NrZWRfc2VydmVyc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgY29uZmlnOiBDbGF1ZGVDb2RlTWNwQ29uZmlnID0ge1xuICAgICAgcGVyX21vZGVsOiB7XG4gICAgICAgIFwiY2xhdWRlLXNvbm5ldFwiOiB7IGFsbG93ZWRfc2VydmVyczogW1wiYVwiLCBcImJcIl0sIGJsb2NrZWRfc2VydmVyczogW1wiY1wiXSB9LFxuICAgICAgfSxcbiAgICB9O1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVNb2RlbE1jcENvbmZpZyhcImNsYXVkZS1zb25uZXQtNC02XCIsIGNvbmZpZyk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQsIHsgYWxsb3dlZF9zZXJ2ZXJzOiBbXCJhXCIsIFwiYlwiXSwgYmxvY2tlZF9zZXJ2ZXJzOiBbXCJjXCJdIH0pO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgdmFsaWRhdGVQcmVmZXJlbmNlcyBcdTIwMTQgY2xhdWRlX2NvZGVfbWNwIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcInZhbGlkYXRlUHJlZmVyZW5jZXMgXHUyMDE0IGNsYXVkZV9jb2RlX21jcFwiLCAoKSA9PiB7XG4gIGl0KFwicGFzc2VzIHdpdGggYSB2YWxpZCBjbGF1ZGVfY29kZV9tY3AgYmxvY2tcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHsgZXJyb3JzLCB3YXJuaW5ncywgcHJlZmVyZW5jZXMgfSA9IHZhbGlkYXRlUHJlZmVyZW5jZXMoe1xuICAgICAgY2xhdWRlX2NvZGVfbWNwOiB7XG4gICAgICAgIHBlcl9tb2RlbDoge1xuICAgICAgICAgIFwiY2xhdWRlLWhhaWt1XCI6IHsgYWxsb3dlZF9zZXJ2ZXJzOiBbXCJtY3AtYVwiXSwgYmxvY2tlZF9zZXJ2ZXJzOiBbXCJtY3AtYlwiXSB9LFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGVycm9ycywgW10pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwod2FybmluZ3MsIFtdKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHByZWZlcmVuY2VzLmNsYXVkZV9jb2RlX21jcCwge1xuICAgICAgcGVyX21vZGVsOiB7XG4gICAgICAgIFwiY2xhdWRlLWhhaWt1XCI6IHsgYWxsb3dlZF9zZXJ2ZXJzOiBbXCJtY3AtYVwiXSwgYmxvY2tlZF9zZXJ2ZXJzOiBbXCJtY3AtYlwiXSB9LFxuICAgICAgfSxcbiAgICB9KTtcbiAgfSk7XG5cbiAgaXQoXCJ3YXJucyBhbmQgaWdub3JlcyB3aGVuIGNsYXVkZV9jb2RlX21jcCBpcyBub3QgYW4gb2JqZWN0XCIsICgpID0+IHtcbiAgICBjb25zdCB7IGVycm9ycywgd2FybmluZ3MgfSA9IHZhbGlkYXRlUHJlZmVyZW5jZXMoe1xuICAgICAgY2xhdWRlX2NvZGVfbWNwOiBcImJhZC12YWx1ZVwiIGFzIHVua25vd24gYXMgb2JqZWN0LFxuICAgIH0pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoZXJyb3JzLCBbXSk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgd2FybmluZ3Muc29tZSgodykgPT4gdy5pbmNsdWRlcyhcImNsYXVkZV9jb2RlX21jcCBtdXN0IGJlIGFuIG9iamVjdFwiKSksXG4gICAgICBgZXhwZWN0ZWQgd2FybmluZyBhYm91dCBub24tb2JqZWN0LCBnb3Q6ICR7SlNPTi5zdHJpbmdpZnkod2FybmluZ3MpfWAsXG4gICAgKTtcbiAgfSk7XG5cbiAgaXQoXCJ3YXJucyB3aGVuIHBlcl9tb2RlbCBlbnRyeSBoYXMgbm9uLWFycmF5IGFsbG93ZWRfc2VydmVyc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgeyBlcnJvcnMsIHdhcm5pbmdzIH0gPSB2YWxpZGF0ZVByZWZlcmVuY2VzKHtcbiAgICAgIGNsYXVkZV9jb2RlX21jcDoge1xuICAgICAgICBwZXJfbW9kZWw6IHtcbiAgICAgICAgICBcImNsYXVkZS1oYWlrdVwiOiB7IGFsbG93ZWRfc2VydmVyczogXCJub3QtYW4tYXJyYXlcIiBhcyB1bmtub3duIGFzIHN0cmluZ1tdIH0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoZXJyb3JzLCBbXSk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgd2FybmluZ3Muc29tZSgodykgPT4gdy5pbmNsdWRlcyhcImFsbG93ZWRfc2VydmVyc1wiKSksXG4gICAgICBgZXhwZWN0ZWQgd2FybmluZyBhYm91dCBhbGxvd2VkX3NlcnZlcnMsIGdvdDogJHtKU09OLnN0cmluZ2lmeSh3YXJuaW5ncyl9YCxcbiAgICApO1xuICB9KTtcblxuICBpdChcIndhcm5zIHdoZW4gcGVyX21vZGVsIGVudHJ5IGhhcyBub24tYXJyYXkgYmxvY2tlZF9zZXJ2ZXJzXCIsICgpID0+IHtcbiAgICBjb25zdCB7IGVycm9ycywgd2FybmluZ3MgfSA9IHZhbGlkYXRlUHJlZmVyZW5jZXMoe1xuICAgICAgY2xhdWRlX2NvZGVfbWNwOiB7XG4gICAgICAgIHBlcl9tb2RlbDoge1xuICAgICAgICAgIFwiY2xhdWRlLWhhaWt1XCI6IHsgYmxvY2tlZF9zZXJ2ZXJzOiA0MiBhcyB1bmtub3duIGFzIHN0cmluZ1tdIH0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoZXJyb3JzLCBbXSk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgd2FybmluZ3Muc29tZSgodykgPT4gdy5pbmNsdWRlcyhcImJsb2NrZWRfc2VydmVyc1wiKSksXG4gICAgICBgZXhwZWN0ZWQgd2FybmluZyBhYm91dCBibG9ja2VkX3NlcnZlcnMsIGdvdDogJHtKU09OLnN0cmluZ2lmeSh3YXJuaW5ncyl9YCxcbiAgICApO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLFVBQVU7QUFDN0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsNkJBQTZCO0FBQ3RD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
