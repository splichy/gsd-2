import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverMcpServerNames, computeMcpDisallowedTools } from "../mcp-filter.js";
describe("discoverMcpServerNames", () => {
  it("reads server names from .mcp.json mcpServers keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-test-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "server-a": {}, "server-b": {} } })
    );
    const result = discoverMcpServerNames(dir);
    assert.deepEqual(result.sort(), ["server-a", "server-b"]);
  });
  it("returns [] when .mcp.json does not exist (ENOENT)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-test-"));
    const result = discoverMcpServerNames(dir);
    assert.deepEqual(result, []);
  });
  it("returns [] when .mcp.json has no mcpServers key", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-test-"));
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ version: 1 }));
    const result = discoverMcpServerNames(dir);
    assert.deepEqual(result, []);
  });
  it("reads from both .mcp.json and .claude/settings.json, deduplicates", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-test-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "server-a": {}, "shared": {} } })
    );
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { "server-b": {}, "shared": {} } })
    );
    const result = discoverMcpServerNames(dir);
    assert.deepEqual(result.sort(), ["server-a", "server-b", "shared"]);
  });
  it("handles .claude/settings.json missing gracefully", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-test-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "only-server": {} } })
    );
    const result = discoverMcpServerNames(dir);
    assert.deepEqual(result, ["only-server"]);
  });
});
describe("computeMcpDisallowedTools", () => {
  it("returns [] when mcpConfig is undefined (no filtering)", () => {
    const result = computeMcpDisallowedTools(
      "claude-haiku-4-5-20251001",
      void 0,
      ["server-a", "server-b"],
      "gsd-workflow"
    );
    assert.deepEqual(result, []);
  });
  it("returns [] when no model prefix matches any config key", () => {
    const config = {
      per_model: {
        "claude-haiku": { allowed_servers: ["server-a"] }
      }
    };
    const result = computeMcpDisallowedTools(
      "claude-opus-4-7",
      config,
      ["server-a", "server-b"],
      "gsd-workflow"
    );
    assert.deepEqual(result, []);
  });
  it("allowlist-only: blocks all discovered servers not in allowed_servers (R002)", () => {
    const config = {
      per_model: {
        "claude-haiku": { allowed_servers: ["server-a"] }
      }
    };
    const result = computeMcpDisallowedTools(
      "claude-haiku-4-5-20251001",
      config,
      ["server-a", "server-b", "server-c"],
      "gsd-workflow"
    );
    assert.deepEqual(result.sort(), ["mcp__server-b__*", "mcp__server-c__*"]);
  });
  it("blocklist-only: blocks only servers in blocked_servers (R002)", () => {
    const config = {
      per_model: {
        "claude-haiku": { blocked_servers: ["server-b"] }
      }
    };
    const result = computeMcpDisallowedTools(
      "claude-haiku-4-5-20251001",
      config,
      ["server-a", "server-b", "server-c"],
      "gsd-workflow"
    );
    assert.deepEqual(result, ["mcp__server-b__*"]);
  });
  it("both lists: allowlist applies first, then blocklist removes; blocklist wins on overlap (R002)", () => {
    const config = {
      per_model: {
        "claude-haiku": {
          allowed_servers: ["server-a", "server-b"],
          blocked_servers: ["server-b"]
        }
      }
    };
    const result = computeMcpDisallowedTools(
      "claude-haiku-4-5-20251001",
      config,
      ["server-a", "server-b", "server-c"],
      "gsd-workflow"
    );
    assert.deepEqual(result.sort(), ["mcp__server-b__*", "mcp__server-c__*"]);
  });
  it("gsd-workflow implicitly allowed even when not in allowlist (R003)", () => {
    const config = {
      per_model: {
        "claude-haiku": { allowed_servers: ["server-a"] }
      }
    };
    const result = computeMcpDisallowedTools(
      "claude-haiku-4-5-20251001",
      config,
      ["server-a", "server-b"],
      "gsd-workflow"
    );
    assert.ok(!result.includes("mcp__gsd-workflow__*"), "gsd-workflow must not be blocked");
    assert.deepEqual(result, ["mcp__server-b__*"]);
  });
  it("gsd-workflow blocked when explicitly in blocked_servers (R003 override)", () => {
    const config = {
      per_model: {
        "claude-haiku": { blocked_servers: ["gsd-workflow"] }
      }
    };
    const result = computeMcpDisallowedTools(
      "claude-haiku-4-5-20251001",
      config,
      ["server-a"],
      "gsd-workflow"
    );
    assert.ok(result.includes("mcp__gsd-workflow__*"), "gsd-workflow must be blocked");
  });
  it("returns mcp__<name>__* pattern format for each blocked server (R006)", () => {
    const config = {
      per_model: {
        "claude-haiku": { blocked_servers: ["my-server", "other-server"] }
      }
    };
    const result = computeMcpDisallowedTools(
      "claude-haiku-4-5-20251001",
      config,
      ["my-server", "other-server"],
      "gsd-workflow"
    );
    assert.deepEqual(result.sort(), ["mcp__my-server__*", "mcp__other-server__*"]);
  });
});
describe("integration: empirical tool-count reduction", () => {
  it("disallowedTools count equals discovered minus allowed (5 servers, 1 allowed \u2192 4 blocked)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-integration-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "server-alpha": {},
          "server-beta": {},
          "server-gamma": {},
          "server-delta": {},
          "server-epsilon": {}
        }
      })
    );
    const discovered = discoverMcpServerNames(dir);
    assert.equal(discovered.length, 5, "fixture must have 5 servers");
    const config = {
      per_model: {
        "test-model": { allowed_servers: ["server-alpha"] }
      }
    };
    const disallowedTools = computeMcpDisallowedTools(
      "test-model",
      config,
      discovered,
      "gsd-workflow"
    );
    assert.equal(disallowedTools.length, 4, "4 servers must be blocked");
    assert.ok(
      !disallowedTools.includes("mcp__server-alpha__*"),
      "server-alpha (allowed) must not be blocked"
    );
    assert.deepEqual(disallowedTools.sort(), [
      "mcp__server-beta__*",
      "mcp__server-delta__*",
      "mcp__server-epsilon__*",
      "mcp__server-gamma__*"
    ]);
  });
  it("negative: empty .mcp.json \u2192 disallowedTools empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-integration-empty-"));
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({}));
    const discovered = discoverMcpServerNames(dir);
    const config = {
      per_model: {
        "test-model": { allowed_servers: ["server-alpha"] }
      }
    };
    const disallowedTools = computeMcpDisallowedTools(
      "test-model",
      config,
      discovered,
      "gsd-workflow"
    );
    assert.deepEqual(disallowedTools, [], "no servers discovered \u2192 nothing to block");
  });
  it("negative: model ID matches no per_model key \u2192 disallowedTools empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-integration-nomatch-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { "server-a": {}, "server-b": {}, "server-c": {} }
      })
    );
    const discovered = discoverMcpServerNames(dir);
    assert.equal(discovered.length, 3);
    const config = {
      per_model: {
        "claude-haiku": { allowed_servers: ["server-a"] }
      }
    };
    const disallowedTools = computeMcpDisallowedTools(
      "gpt-4o",
      config,
      discovered,
      "gsd-workflow"
    );
    assert.deepEqual(disallowedTools, [], "unmatched model must produce no blocks");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9tY3AtZmlsdGVyLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGRlc2NyaWJlLCBpdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIHdyaXRlRmlsZVN5bmMsIG1rZGlyU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHsgZGlzY292ZXJNY3BTZXJ2ZXJOYW1lcywgY29tcHV0ZU1jcERpc2FsbG93ZWRUb29scyB9IGZyb20gXCIuLi9tY3AtZmlsdGVyLnRzXCI7XG5pbXBvcnQgdHlwZSB7IENsYXVkZUNvZGVNY3BDb25maWcgfSBmcm9tIFwiLi4vcHJlZmVyZW5jZXMtdHlwZXMudHNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGRpc2NvdmVyTWNwU2VydmVyTmFtZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiZGlzY292ZXJNY3BTZXJ2ZXJOYW1lc1wiLCAoKSA9PiB7XG4gIGl0KFwicmVhZHMgc2VydmVyIG5hbWVzIGZyb20gLm1jcC5qc29uIG1jcFNlcnZlcnMga2V5c1wiLCAoKSA9PiB7XG4gICAgY29uc3QgZGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJtY3AtZmlsdGVyLXRlc3QtXCIpKTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihkaXIsIFwiLm1jcC5qc29uXCIpLFxuICAgICAgSlNPTi5zdHJpbmdpZnkoeyBtY3BTZXJ2ZXJzOiB7IFwic2VydmVyLWFcIjoge30sIFwic2VydmVyLWJcIjoge30gfSB9KSxcbiAgICApO1xuICAgIGNvbnN0IHJlc3VsdCA9IGRpc2NvdmVyTWNwU2VydmVyTmFtZXMoZGlyKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdC5zb3J0KCksIFtcInNlcnZlci1hXCIsIFwic2VydmVyLWJcIl0pO1xuICB9KTtcblxuICBpdChcInJldHVybnMgW10gd2hlbiAubWNwLmpzb24gZG9lcyBub3QgZXhpc3QgKEVOT0VOVClcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwibWNwLWZpbHRlci10ZXN0LVwiKSk7XG4gICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJNY3BTZXJ2ZXJOYW1lcyhkaXIpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LCBbXSk7XG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyBbXSB3aGVuIC5tY3AuanNvbiBoYXMgbm8gbWNwU2VydmVycyBrZXlcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwibWNwLWZpbHRlci10ZXN0LVwiKSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCIubWNwLmpzb25cIiksIEpTT04uc3RyaW5naWZ5KHsgdmVyc2lvbjogMSB9KSk7XG4gICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJNY3BTZXJ2ZXJOYW1lcyhkaXIpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LCBbXSk7XG4gIH0pO1xuXG4gIGl0KFwicmVhZHMgZnJvbSBib3RoIC5tY3AuanNvbiBhbmQgLmNsYXVkZS9zZXR0aW5ncy5qc29uLCBkZWR1cGxpY2F0ZXNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwibWNwLWZpbHRlci10ZXN0LVwiKSk7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oZGlyLCBcIi5tY3AuanNvblwiKSxcbiAgICAgIEpTT04uc3RyaW5naWZ5KHsgbWNwU2VydmVyczogeyBcInNlcnZlci1hXCI6IHt9LCBcInNoYXJlZFwiOiB7fSB9IH0pLFxuICAgICk7XG4gICAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcIi5jbGF1ZGVcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGRpciwgXCIuY2xhdWRlXCIsIFwic2V0dGluZ3MuanNvblwiKSxcbiAgICAgIEpTT04uc3RyaW5naWZ5KHsgbWNwU2VydmVyczogeyBcInNlcnZlci1iXCI6IHt9LCBcInNoYXJlZFwiOiB7fSB9IH0pLFxuICAgICk7XG4gICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJNY3BTZXJ2ZXJOYW1lcyhkaXIpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LnNvcnQoKSwgW1wic2VydmVyLWFcIiwgXCJzZXJ2ZXItYlwiLCBcInNoYXJlZFwiXSk7XG4gIH0pO1xuXG4gIGl0KFwiaGFuZGxlcyAuY2xhdWRlL3NldHRpbmdzLmpzb24gbWlzc2luZyBncmFjZWZ1bGx5XCIsICgpID0+IHtcbiAgICBjb25zdCBkaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcIm1jcC1maWx0ZXItdGVzdC1cIikpO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGRpciwgXCIubWNwLmpzb25cIiksXG4gICAgICBKU09OLnN0cmluZ2lmeSh7IG1jcFNlcnZlcnM6IHsgXCJvbmx5LXNlcnZlclwiOiB7fSB9IH0pLFxuICAgICk7XG4gICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJNY3BTZXJ2ZXJOYW1lcyhkaXIpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LCBbXCJvbmx5LXNlcnZlclwiXSk7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBjb21wdXRlTWNwRGlzYWxsb3dlZFRvb2xzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcImNvbXB1dGVNY3BEaXNhbGxvd2VkVG9vbHNcIiwgKCkgPT4ge1xuICBpdChcInJldHVybnMgW10gd2hlbiBtY3BDb25maWcgaXMgdW5kZWZpbmVkIChubyBmaWx0ZXJpbmcpXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBjb21wdXRlTWNwRGlzYWxsb3dlZFRvb2xzKFxuICAgICAgXCJjbGF1ZGUtaGFpa3UtNC01LTIwMjUxMDAxXCIsXG4gICAgICB1bmRlZmluZWQsXG4gICAgICBbXCJzZXJ2ZXItYVwiLCBcInNlcnZlci1iXCJdLFxuICAgICAgXCJnc2Qtd29ya2Zsb3dcIixcbiAgICApO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LCBbXSk7XG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyBbXSB3aGVuIG5vIG1vZGVsIHByZWZpeCBtYXRjaGVzIGFueSBjb25maWcga2V5XCIsICgpID0+IHtcbiAgICBjb25zdCBjb25maWc6IENsYXVkZUNvZGVNY3BDb25maWcgPSB7XG4gICAgICBwZXJfbW9kZWw6IHtcbiAgICAgICAgXCJjbGF1ZGUtaGFpa3VcIjogeyBhbGxvd2VkX3NlcnZlcnM6IFtcInNlcnZlci1hXCJdIH0sXG4gICAgICB9LFxuICAgIH07XG4gICAgY29uc3QgcmVzdWx0ID0gY29tcHV0ZU1jcERpc2FsbG93ZWRUb29scyhcbiAgICAgIFwiY2xhdWRlLW9wdXMtNC03XCIsXG4gICAgICBjb25maWcsXG4gICAgICBbXCJzZXJ2ZXItYVwiLCBcInNlcnZlci1iXCJdLFxuICAgICAgXCJnc2Qtd29ya2Zsb3dcIixcbiAgICApO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LCBbXSk7XG4gIH0pO1xuXG4gIGl0KFwiYWxsb3dsaXN0LW9ubHk6IGJsb2NrcyBhbGwgZGlzY292ZXJlZCBzZXJ2ZXJzIG5vdCBpbiBhbGxvd2VkX3NlcnZlcnMgKFIwMDIpXCIsICgpID0+IHtcbiAgICBjb25zdCBjb25maWc6IENsYXVkZUNvZGVNY3BDb25maWcgPSB7XG4gICAgICBwZXJfbW9kZWw6IHtcbiAgICAgICAgXCJjbGF1ZGUtaGFpa3VcIjogeyBhbGxvd2VkX3NlcnZlcnM6IFtcInNlcnZlci1hXCJdIH0sXG4gICAgICB9LFxuICAgIH07XG4gICAgY29uc3QgcmVzdWx0ID0gY29tcHV0ZU1jcERpc2FsbG93ZWRUb29scyhcbiAgICAgIFwiY2xhdWRlLWhhaWt1LTQtNS0yMDI1MTAwMVwiLFxuICAgICAgY29uZmlnLFxuICAgICAgW1wic2VydmVyLWFcIiwgXCJzZXJ2ZXItYlwiLCBcInNlcnZlci1jXCJdLFxuICAgICAgXCJnc2Qtd29ya2Zsb3dcIixcbiAgICApO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LnNvcnQoKSwgW1wibWNwX19zZXJ2ZXItYl9fKlwiLCBcIm1jcF9fc2VydmVyLWNfXypcIl0pO1xuICB9KTtcblxuICBpdChcImJsb2NrbGlzdC1vbmx5OiBibG9ja3Mgb25seSBzZXJ2ZXJzIGluIGJsb2NrZWRfc2VydmVycyAoUjAwMilcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvbmZpZzogQ2xhdWRlQ29kZU1jcENvbmZpZyA9IHtcbiAgICAgIHBlcl9tb2RlbDoge1xuICAgICAgICBcImNsYXVkZS1oYWlrdVwiOiB7IGJsb2NrZWRfc2VydmVyczogW1wic2VydmVyLWJcIl0gfSxcbiAgICAgIH0sXG4gICAgfTtcbiAgICBjb25zdCByZXN1bHQgPSBjb21wdXRlTWNwRGlzYWxsb3dlZFRvb2xzKFxuICAgICAgXCJjbGF1ZGUtaGFpa3UtNC01LTIwMjUxMDAxXCIsXG4gICAgICBjb25maWcsXG4gICAgICBbXCJzZXJ2ZXItYVwiLCBcInNlcnZlci1iXCIsIFwic2VydmVyLWNcIl0sXG4gICAgICBcImdzZC13b3JrZmxvd1wiLFxuICAgICk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQsIFtcIm1jcF9fc2VydmVyLWJfXypcIl0pO1xuICB9KTtcblxuICBpdChcImJvdGggbGlzdHM6IGFsbG93bGlzdCBhcHBsaWVzIGZpcnN0LCB0aGVuIGJsb2NrbGlzdCByZW1vdmVzOyBibG9ja2xpc3Qgd2lucyBvbiBvdmVybGFwIChSMDAyKVwiLCAoKSA9PiB7XG4gICAgY29uc3QgY29uZmlnOiBDbGF1ZGVDb2RlTWNwQ29uZmlnID0ge1xuICAgICAgcGVyX21vZGVsOiB7XG4gICAgICAgIFwiY2xhdWRlLWhhaWt1XCI6IHtcbiAgICAgICAgICBhbGxvd2VkX3NlcnZlcnM6IFtcInNlcnZlci1hXCIsIFwic2VydmVyLWJcIl0sXG4gICAgICAgICAgYmxvY2tlZF9zZXJ2ZXJzOiBbXCJzZXJ2ZXItYlwiXSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfTtcbiAgICBjb25zdCByZXN1bHQgPSBjb21wdXRlTWNwRGlzYWxsb3dlZFRvb2xzKFxuICAgICAgXCJjbGF1ZGUtaGFpa3UtNC01LTIwMjUxMDAxXCIsXG4gICAgICBjb25maWcsXG4gICAgICBbXCJzZXJ2ZXItYVwiLCBcInNlcnZlci1iXCIsIFwic2VydmVyLWNcIl0sXG4gICAgICBcImdzZC13b3JrZmxvd1wiLFxuICAgICk7XG4gICAgLy8gc2VydmVyLWMgYmxvY2tlZCBieSBhbGxvd2xpc3QsIHNlcnZlci1iIGJsb2NrZWQgYnkgYmxvY2tsaXN0ICh3aW5zIG92ZXIgYWxsb3dsaXN0KVxuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LnNvcnQoKSwgW1wibWNwX19zZXJ2ZXItYl9fKlwiLCBcIm1jcF9fc2VydmVyLWNfXypcIl0pO1xuICB9KTtcblxuICBpdChcImdzZC13b3JrZmxvdyBpbXBsaWNpdGx5IGFsbG93ZWQgZXZlbiB3aGVuIG5vdCBpbiBhbGxvd2xpc3QgKFIwMDMpXCIsICgpID0+IHtcbiAgICBjb25zdCBjb25maWc6IENsYXVkZUNvZGVNY3BDb25maWcgPSB7XG4gICAgICBwZXJfbW9kZWw6IHtcbiAgICAgICAgXCJjbGF1ZGUtaGFpa3VcIjogeyBhbGxvd2VkX3NlcnZlcnM6IFtcInNlcnZlci1hXCJdIH0sXG4gICAgICB9LFxuICAgIH07XG4gICAgY29uc3QgcmVzdWx0ID0gY29tcHV0ZU1jcERpc2FsbG93ZWRUb29scyhcbiAgICAgIFwiY2xhdWRlLWhhaWt1LTQtNS0yMDI1MTAwMVwiLFxuICAgICAgY29uZmlnLFxuICAgICAgW1wic2VydmVyLWFcIiwgXCJzZXJ2ZXItYlwiXSxcbiAgICAgIFwiZ3NkLXdvcmtmbG93XCIsXG4gICAgKTtcbiAgICBhc3NlcnQub2soIXJlc3VsdC5pbmNsdWRlcyhcIm1jcF9fZ3NkLXdvcmtmbG93X18qXCIpLCBcImdzZC13b3JrZmxvdyBtdXN0IG5vdCBiZSBibG9ja2VkXCIpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LCBbXCJtY3BfX3NlcnZlci1iX18qXCJdKTtcbiAgfSk7XG5cbiAgaXQoXCJnc2Qtd29ya2Zsb3cgYmxvY2tlZCB3aGVuIGV4cGxpY2l0bHkgaW4gYmxvY2tlZF9zZXJ2ZXJzIChSMDAzIG92ZXJyaWRlKVwiLCAoKSA9PiB7XG4gICAgY29uc3QgY29uZmlnOiBDbGF1ZGVDb2RlTWNwQ29uZmlnID0ge1xuICAgICAgcGVyX21vZGVsOiB7XG4gICAgICAgIFwiY2xhdWRlLWhhaWt1XCI6IHsgYmxvY2tlZF9zZXJ2ZXJzOiBbXCJnc2Qtd29ya2Zsb3dcIl0gfSxcbiAgICAgIH0sXG4gICAgfTtcbiAgICBjb25zdCByZXN1bHQgPSBjb21wdXRlTWNwRGlzYWxsb3dlZFRvb2xzKFxuICAgICAgXCJjbGF1ZGUtaGFpa3UtNC01LTIwMjUxMDAxXCIsXG4gICAgICBjb25maWcsXG4gICAgICBbXCJzZXJ2ZXItYVwiXSxcbiAgICAgIFwiZ3NkLXdvcmtmbG93XCIsXG4gICAgKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwibWNwX19nc2Qtd29ya2Zsb3dfXypcIiksIFwiZ3NkLXdvcmtmbG93IG11c3QgYmUgYmxvY2tlZFwiKTtcbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIG1jcF9fPG5hbWU+X18qIHBhdHRlcm4gZm9ybWF0IGZvciBlYWNoIGJsb2NrZWQgc2VydmVyIChSMDA2KVwiLCAoKSA9PiB7XG4gICAgY29uc3QgY29uZmlnOiBDbGF1ZGVDb2RlTWNwQ29uZmlnID0ge1xuICAgICAgcGVyX21vZGVsOiB7XG4gICAgICAgIFwiY2xhdWRlLWhhaWt1XCI6IHsgYmxvY2tlZF9zZXJ2ZXJzOiBbXCJteS1zZXJ2ZXJcIiwgXCJvdGhlci1zZXJ2ZXJcIl0gfSxcbiAgICAgIH0sXG4gICAgfTtcbiAgICBjb25zdCByZXN1bHQgPSBjb21wdXRlTWNwRGlzYWxsb3dlZFRvb2xzKFxuICAgICAgXCJjbGF1ZGUtaGFpa3UtNC01LTIwMjUxMDAxXCIsXG4gICAgICBjb25maWcsXG4gICAgICBbXCJteS1zZXJ2ZXJcIiwgXCJvdGhlci1zZXJ2ZXJcIl0sXG4gICAgICBcImdzZC13b3JrZmxvd1wiLFxuICAgICk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQuc29ydCgpLCBbXCJtY3BfX215LXNlcnZlcl9fKlwiLCBcIm1jcF9fb3RoZXItc2VydmVyX18qXCJdKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEludGVncmF0aW9uOiBlbXBpcmljYWwgdG9vbC1jb3VudCByZWR1Y3Rpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiaW50ZWdyYXRpb246IGVtcGlyaWNhbCB0b29sLWNvdW50IHJlZHVjdGlvblwiLCAoKSA9PiB7XG4gIGl0KFwiZGlzYWxsb3dlZFRvb2xzIGNvdW50IGVxdWFscyBkaXNjb3ZlcmVkIG1pbnVzIGFsbG93ZWQgKDUgc2VydmVycywgMSBhbGxvd2VkIFx1MjE5MiA0IGJsb2NrZWQpXCIsICgpID0+IHtcbiAgICBjb25zdCBkaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcIm1jcC1maWx0ZXItaW50ZWdyYXRpb24tXCIpKTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihkaXIsIFwiLm1jcC5qc29uXCIpLFxuICAgICAgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBtY3BTZXJ2ZXJzOiB7XG4gICAgICAgICAgXCJzZXJ2ZXItYWxwaGFcIjoge30sXG4gICAgICAgICAgXCJzZXJ2ZXItYmV0YVwiOiB7fSxcbiAgICAgICAgICBcInNlcnZlci1nYW1tYVwiOiB7fSxcbiAgICAgICAgICBcInNlcnZlci1kZWx0YVwiOiB7fSxcbiAgICAgICAgICBcInNlcnZlci1lcHNpbG9uXCI6IHt9LFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIGNvbnN0IGRpc2NvdmVyZWQgPSBkaXNjb3Zlck1jcFNlcnZlck5hbWVzKGRpcik7XG4gICAgYXNzZXJ0LmVxdWFsKGRpc2NvdmVyZWQubGVuZ3RoLCA1LCBcImZpeHR1cmUgbXVzdCBoYXZlIDUgc2VydmVyc1wiKTtcblxuICAgIGNvbnN0IGNvbmZpZzogQ2xhdWRlQ29kZU1jcENvbmZpZyA9IHtcbiAgICAgIHBlcl9tb2RlbDoge1xuICAgICAgICBcInRlc3QtbW9kZWxcIjogeyBhbGxvd2VkX3NlcnZlcnM6IFtcInNlcnZlci1hbHBoYVwiXSB9LFxuICAgICAgfSxcbiAgICB9O1xuXG4gICAgY29uc3QgZGlzYWxsb3dlZFRvb2xzID0gY29tcHV0ZU1jcERpc2FsbG93ZWRUb29scyhcbiAgICAgIFwidGVzdC1tb2RlbFwiLFxuICAgICAgY29uZmlnLFxuICAgICAgZGlzY292ZXJlZCxcbiAgICAgIFwiZ3NkLXdvcmtmbG93XCIsXG4gICAgKTtcblxuICAgIC8vIDUgZGlzY292ZXJlZCAtIDEgYWxsb3dlZCA9IDQgYmxvY2tlZFxuICAgIGFzc2VydC5lcXVhbChkaXNhbGxvd2VkVG9vbHMubGVuZ3RoLCA0LCBcIjQgc2VydmVycyBtdXN0IGJlIGJsb2NrZWRcIik7XG5cbiAgICAvLyBUaGUgYWxsb3dlZCBzZXJ2ZXIgbXVzdCBOT1QgYmUgaW4gZGlzYWxsb3dlZFRvb2xzXG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgIWRpc2FsbG93ZWRUb29scy5pbmNsdWRlcyhcIm1jcF9fc2VydmVyLWFscGhhX18qXCIpLFxuICAgICAgXCJzZXJ2ZXItYWxwaGEgKGFsbG93ZWQpIG11c3Qgbm90IGJlIGJsb2NrZWRcIixcbiAgICApO1xuXG4gICAgLy8gRWFjaCBibG9ja2VkIHNlcnZlciBtdXN0IHByb2R1Y2UgdGhlIGNvcnJlY3QgcGF0dGVyblxuICAgIGFzc2VydC5kZWVwRXF1YWwoZGlzYWxsb3dlZFRvb2xzLnNvcnQoKSwgW1xuICAgICAgXCJtY3BfX3NlcnZlci1iZXRhX18qXCIsXG4gICAgICBcIm1jcF9fc2VydmVyLWRlbHRhX18qXCIsXG4gICAgICBcIm1jcF9fc2VydmVyLWVwc2lsb25fXypcIixcbiAgICAgIFwibWNwX19zZXJ2ZXItZ2FtbWFfXypcIixcbiAgICBdKTtcbiAgfSk7XG5cbiAgaXQoXCJuZWdhdGl2ZTogZW1wdHkgLm1jcC5qc29uIFx1MjE5MiBkaXNhbGxvd2VkVG9vbHMgZW1wdHlcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwibWNwLWZpbHRlci1pbnRlZ3JhdGlvbi1lbXB0eS1cIikpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiLm1jcC5qc29uXCIpLCBKU09OLnN0cmluZ2lmeSh7fSkpO1xuXG4gICAgY29uc3QgZGlzY292ZXJlZCA9IGRpc2NvdmVyTWNwU2VydmVyTmFtZXMoZGlyKTtcbiAgICBjb25zdCBjb25maWc6IENsYXVkZUNvZGVNY3BDb25maWcgPSB7XG4gICAgICBwZXJfbW9kZWw6IHtcbiAgICAgICAgXCJ0ZXN0LW1vZGVsXCI6IHsgYWxsb3dlZF9zZXJ2ZXJzOiBbXCJzZXJ2ZXItYWxwaGFcIl0gfSxcbiAgICAgIH0sXG4gICAgfTtcblxuICAgIGNvbnN0IGRpc2FsbG93ZWRUb29scyA9IGNvbXB1dGVNY3BEaXNhbGxvd2VkVG9vbHMoXG4gICAgICBcInRlc3QtbW9kZWxcIixcbiAgICAgIGNvbmZpZyxcbiAgICAgIGRpc2NvdmVyZWQsXG4gICAgICBcImdzZC13b3JrZmxvd1wiLFxuICAgICk7XG5cbiAgICBhc3NlcnQuZGVlcEVxdWFsKGRpc2FsbG93ZWRUb29scywgW10sIFwibm8gc2VydmVycyBkaXNjb3ZlcmVkIFx1MjE5MiBub3RoaW5nIHRvIGJsb2NrXCIpO1xuICB9KTtcblxuICBpdChcIm5lZ2F0aXZlOiBtb2RlbCBJRCBtYXRjaGVzIG5vIHBlcl9tb2RlbCBrZXkgXHUyMTkyIGRpc2FsbG93ZWRUb29scyBlbXB0eVwiLCAoKSA9PiB7XG4gICAgY29uc3QgZGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJtY3AtZmlsdGVyLWludGVncmF0aW9uLW5vbWF0Y2gtXCIpKTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihkaXIsIFwiLm1jcC5qc29uXCIpLFxuICAgICAgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBtY3BTZXJ2ZXJzOiB7IFwic2VydmVyLWFcIjoge30sIFwic2VydmVyLWJcIjoge30sIFwic2VydmVyLWNcIjoge30gfSxcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICBjb25zdCBkaXNjb3ZlcmVkID0gZGlzY292ZXJNY3BTZXJ2ZXJOYW1lcyhkaXIpO1xuICAgIGFzc2VydC5lcXVhbChkaXNjb3ZlcmVkLmxlbmd0aCwgMyk7XG5cbiAgICBjb25zdCBjb25maWc6IENsYXVkZUNvZGVNY3BDb25maWcgPSB7XG4gICAgICBwZXJfbW9kZWw6IHtcbiAgICAgICAgXCJjbGF1ZGUtaGFpa3VcIjogeyBhbGxvd2VkX3NlcnZlcnM6IFtcInNlcnZlci1hXCJdIH0sXG4gICAgICB9LFxuICAgIH07XG5cbiAgICAvLyBcImdwdC00b1wiIGRvZXNuJ3QgbWF0Y2ggXCJjbGF1ZGUtaGFpa3VcIiBwcmVmaXggXHUyMTkyIG5vIGZpbHRlcmluZ1xuICAgIGNvbnN0IGRpc2FsbG93ZWRUb29scyA9IGNvbXB1dGVNY3BEaXNhbGxvd2VkVG9vbHMoXG4gICAgICBcImdwdC00b1wiLFxuICAgICAgY29uZmlnLFxuICAgICAgZGlzY292ZXJlZCxcbiAgICAgIFwiZ3NkLXdvcmtmbG93XCIsXG4gICAgKTtcblxuICAgIGFzc2VydC5kZWVwRXF1YWwoZGlzYWxsb3dlZFRvb2xzLCBbXSwgXCJ1bm1hdGNoZWQgbW9kZWwgbXVzdCBwcm9kdWNlIG5vIGJsb2Nrc1wiKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsVUFBVSxVQUFVO0FBQzdCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsZUFBZSxpQkFBaUI7QUFDdEQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QixTQUFTLHdCQUF3QixpQ0FBaUM7QUFLbEUsU0FBUywwQkFBMEIsTUFBTTtBQUN2QyxLQUFHLHFEQUFxRCxNQUFNO0FBQzVELFVBQU0sTUFBTSxZQUFZLEtBQUssT0FBTyxHQUFHLGtCQUFrQixDQUFDO0FBQzFEO0FBQUEsTUFDRSxLQUFLLEtBQUssV0FBVztBQUFBLE1BQ3JCLEtBQUssVUFBVSxFQUFFLFlBQVksRUFBRSxZQUFZLENBQUMsR0FBRyxZQUFZLENBQUMsRUFBRSxFQUFFLENBQUM7QUFBQSxJQUNuRTtBQUNBLFVBQU0sU0FBUyx1QkFBdUIsR0FBRztBQUN6QyxXQUFPLFVBQVUsT0FBTyxLQUFLLEdBQUcsQ0FBQyxZQUFZLFVBQVUsQ0FBQztBQUFBLEVBQzFELENBQUM7QUFFRCxLQUFHLHFEQUFxRCxNQUFNO0FBQzVELFVBQU0sTUFBTSxZQUFZLEtBQUssT0FBTyxHQUFHLGtCQUFrQixDQUFDO0FBQzFELFVBQU0sU0FBUyx1QkFBdUIsR0FBRztBQUN6QyxXQUFPLFVBQVUsUUFBUSxDQUFDLENBQUM7QUFBQSxFQUM3QixDQUFDO0FBRUQsS0FBRyxtREFBbUQsTUFBTTtBQUMxRCxVQUFNLE1BQU0sWUFBWSxLQUFLLE9BQU8sR0FBRyxrQkFBa0IsQ0FBQztBQUMxRCxrQkFBYyxLQUFLLEtBQUssV0FBVyxHQUFHLEtBQUssVUFBVSxFQUFFLFNBQVMsRUFBRSxDQUFDLENBQUM7QUFDcEUsVUFBTSxTQUFTLHVCQUF1QixHQUFHO0FBQ3pDLFdBQU8sVUFBVSxRQUFRLENBQUMsQ0FBQztBQUFBLEVBQzdCLENBQUM7QUFFRCxLQUFHLHFFQUFxRSxNQUFNO0FBQzVFLFVBQU0sTUFBTSxZQUFZLEtBQUssT0FBTyxHQUFHLGtCQUFrQixDQUFDO0FBQzFEO0FBQUEsTUFDRSxLQUFLLEtBQUssV0FBVztBQUFBLE1BQ3JCLEtBQUssVUFBVSxFQUFFLFlBQVksRUFBRSxZQUFZLENBQUMsR0FBRyxVQUFVLENBQUMsRUFBRSxFQUFFLENBQUM7QUFBQSxJQUNqRTtBQUNBLGNBQVUsS0FBSyxLQUFLLFNBQVMsR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ25EO0FBQUEsTUFDRSxLQUFLLEtBQUssV0FBVyxlQUFlO0FBQUEsTUFDcEMsS0FBSyxVQUFVLEVBQUUsWUFBWSxFQUFFLFlBQVksQ0FBQyxHQUFHLFVBQVUsQ0FBQyxFQUFFLEVBQUUsQ0FBQztBQUFBLElBQ2pFO0FBQ0EsVUFBTSxTQUFTLHVCQUF1QixHQUFHO0FBQ3pDLFdBQU8sVUFBVSxPQUFPLEtBQUssR0FBRyxDQUFDLFlBQVksWUFBWSxRQUFRLENBQUM7QUFBQSxFQUNwRSxDQUFDO0FBRUQsS0FBRyxvREFBb0QsTUFBTTtBQUMzRCxVQUFNLE1BQU0sWUFBWSxLQUFLLE9BQU8sR0FBRyxrQkFBa0IsQ0FBQztBQUMxRDtBQUFBLE1BQ0UsS0FBSyxLQUFLLFdBQVc7QUFBQSxNQUNyQixLQUFLLFVBQVUsRUFBRSxZQUFZLEVBQUUsZUFBZSxDQUFDLEVBQUUsRUFBRSxDQUFDO0FBQUEsSUFDdEQ7QUFDQSxVQUFNLFNBQVMsdUJBQXVCLEdBQUc7QUFDekMsV0FBTyxVQUFVLFFBQVEsQ0FBQyxhQUFhLENBQUM7QUFBQSxFQUMxQyxDQUFDO0FBQ0gsQ0FBQztBQUlELFNBQVMsNkJBQTZCLE1BQU07QUFDMUMsS0FBRyx5REFBeUQsTUFBTTtBQUNoRSxVQUFNLFNBQVM7QUFBQSxNQUNiO0FBQUEsTUFDQTtBQUFBLE1BQ0EsQ0FBQyxZQUFZLFVBQVU7QUFBQSxNQUN2QjtBQUFBLElBQ0Y7QUFDQSxXQUFPLFVBQVUsUUFBUSxDQUFDLENBQUM7QUFBQSxFQUM3QixDQUFDO0FBRUQsS0FBRywwREFBMEQsTUFBTTtBQUNqRSxVQUFNLFNBQThCO0FBQUEsTUFDbEMsV0FBVztBQUFBLFFBQ1QsZ0JBQWdCLEVBQUUsaUJBQWlCLENBQUMsVUFBVSxFQUFFO0FBQUEsTUFDbEQ7QUFBQSxJQUNGO0FBQ0EsVUFBTSxTQUFTO0FBQUEsTUFDYjtBQUFBLE1BQ0E7QUFBQSxNQUNBLENBQUMsWUFBWSxVQUFVO0FBQUEsTUFDdkI7QUFBQSxJQUNGO0FBQ0EsV0FBTyxVQUFVLFFBQVEsQ0FBQyxDQUFDO0FBQUEsRUFDN0IsQ0FBQztBQUVELEtBQUcsK0VBQStFLE1BQU07QUFDdEYsVUFBTSxTQUE4QjtBQUFBLE1BQ2xDLFdBQVc7QUFBQSxRQUNULGdCQUFnQixFQUFFLGlCQUFpQixDQUFDLFVBQVUsRUFBRTtBQUFBLE1BQ2xEO0FBQUEsSUFDRjtBQUNBLFVBQU0sU0FBUztBQUFBLE1BQ2I7QUFBQSxNQUNBO0FBQUEsTUFDQSxDQUFDLFlBQVksWUFBWSxVQUFVO0FBQUEsTUFDbkM7QUFBQSxJQUNGO0FBQ0EsV0FBTyxVQUFVLE9BQU8sS0FBSyxHQUFHLENBQUMsb0JBQW9CLGtCQUFrQixDQUFDO0FBQUEsRUFDMUUsQ0FBQztBQUVELEtBQUcsaUVBQWlFLE1BQU07QUFDeEUsVUFBTSxTQUE4QjtBQUFBLE1BQ2xDLFdBQVc7QUFBQSxRQUNULGdCQUFnQixFQUFFLGlCQUFpQixDQUFDLFVBQVUsRUFBRTtBQUFBLE1BQ2xEO0FBQUEsSUFDRjtBQUNBLFVBQU0sU0FBUztBQUFBLE1BQ2I7QUFBQSxNQUNBO0FBQUEsTUFDQSxDQUFDLFlBQVksWUFBWSxVQUFVO0FBQUEsTUFDbkM7QUFBQSxJQUNGO0FBQ0EsV0FBTyxVQUFVLFFBQVEsQ0FBQyxrQkFBa0IsQ0FBQztBQUFBLEVBQy9DLENBQUM7QUFFRCxLQUFHLGlHQUFpRyxNQUFNO0FBQ3hHLFVBQU0sU0FBOEI7QUFBQSxNQUNsQyxXQUFXO0FBQUEsUUFDVCxnQkFBZ0I7QUFBQSxVQUNkLGlCQUFpQixDQUFDLFlBQVksVUFBVTtBQUFBLFVBQ3hDLGlCQUFpQixDQUFDLFVBQVU7QUFBQSxRQUM5QjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQ0EsVUFBTSxTQUFTO0FBQUEsTUFDYjtBQUFBLE1BQ0E7QUFBQSxNQUNBLENBQUMsWUFBWSxZQUFZLFVBQVU7QUFBQSxNQUNuQztBQUFBLElBQ0Y7QUFFQSxXQUFPLFVBQVUsT0FBTyxLQUFLLEdBQUcsQ0FBQyxvQkFBb0Isa0JBQWtCLENBQUM7QUFBQSxFQUMxRSxDQUFDO0FBRUQsS0FBRyxxRUFBcUUsTUFBTTtBQUM1RSxVQUFNLFNBQThCO0FBQUEsTUFDbEMsV0FBVztBQUFBLFFBQ1QsZ0JBQWdCLEVBQUUsaUJBQWlCLENBQUMsVUFBVSxFQUFFO0FBQUEsTUFDbEQ7QUFBQSxJQUNGO0FBQ0EsVUFBTSxTQUFTO0FBQUEsTUFDYjtBQUFBLE1BQ0E7QUFBQSxNQUNBLENBQUMsWUFBWSxVQUFVO0FBQUEsTUFDdkI7QUFBQSxJQUNGO0FBQ0EsV0FBTyxHQUFHLENBQUMsT0FBTyxTQUFTLHNCQUFzQixHQUFHLGtDQUFrQztBQUN0RixXQUFPLFVBQVUsUUFBUSxDQUFDLGtCQUFrQixDQUFDO0FBQUEsRUFDL0MsQ0FBQztBQUVELEtBQUcsMkVBQTJFLE1BQU07QUFDbEYsVUFBTSxTQUE4QjtBQUFBLE1BQ2xDLFdBQVc7QUFBQSxRQUNULGdCQUFnQixFQUFFLGlCQUFpQixDQUFDLGNBQWMsRUFBRTtBQUFBLE1BQ3REO0FBQUEsSUFDRjtBQUNBLFVBQU0sU0FBUztBQUFBLE1BQ2I7QUFBQSxNQUNBO0FBQUEsTUFDQSxDQUFDLFVBQVU7QUFBQSxNQUNYO0FBQUEsSUFDRjtBQUNBLFdBQU8sR0FBRyxPQUFPLFNBQVMsc0JBQXNCLEdBQUcsOEJBQThCO0FBQUEsRUFDbkYsQ0FBQztBQUVELEtBQUcsd0VBQXdFLE1BQU07QUFDL0UsVUFBTSxTQUE4QjtBQUFBLE1BQ2xDLFdBQVc7QUFBQSxRQUNULGdCQUFnQixFQUFFLGlCQUFpQixDQUFDLGFBQWEsY0FBYyxFQUFFO0FBQUEsTUFDbkU7QUFBQSxJQUNGO0FBQ0EsVUFBTSxTQUFTO0FBQUEsTUFDYjtBQUFBLE1BQ0E7QUFBQSxNQUNBLENBQUMsYUFBYSxjQUFjO0FBQUEsTUFDNUI7QUFBQSxJQUNGO0FBQ0EsV0FBTyxVQUFVLE9BQU8sS0FBSyxHQUFHLENBQUMscUJBQXFCLHNCQUFzQixDQUFDO0FBQUEsRUFDL0UsQ0FBQztBQUNILENBQUM7QUFJRCxTQUFTLCtDQUErQyxNQUFNO0FBQzVELEtBQUcsaUdBQTRGLE1BQU07QUFDbkcsVUFBTSxNQUFNLFlBQVksS0FBSyxPQUFPLEdBQUcseUJBQXlCLENBQUM7QUFDakU7QUFBQSxNQUNFLEtBQUssS0FBSyxXQUFXO0FBQUEsTUFDckIsS0FBSyxVQUFVO0FBQUEsUUFDYixZQUFZO0FBQUEsVUFDVixnQkFBZ0IsQ0FBQztBQUFBLFVBQ2pCLGVBQWUsQ0FBQztBQUFBLFVBQ2hCLGdCQUFnQixDQUFDO0FBQUEsVUFDakIsZ0JBQWdCLENBQUM7QUFBQSxVQUNqQixrQkFBa0IsQ0FBQztBQUFBLFFBQ3JCO0FBQUEsTUFDRixDQUFDO0FBQUEsSUFDSDtBQUVBLFVBQU0sYUFBYSx1QkFBdUIsR0FBRztBQUM3QyxXQUFPLE1BQU0sV0FBVyxRQUFRLEdBQUcsNkJBQTZCO0FBRWhFLFVBQU0sU0FBOEI7QUFBQSxNQUNsQyxXQUFXO0FBQUEsUUFDVCxjQUFjLEVBQUUsaUJBQWlCLENBQUMsY0FBYyxFQUFFO0FBQUEsTUFDcEQ7QUFBQSxJQUNGO0FBRUEsVUFBTSxrQkFBa0I7QUFBQSxNQUN0QjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFHQSxXQUFPLE1BQU0sZ0JBQWdCLFFBQVEsR0FBRywyQkFBMkI7QUFHbkUsV0FBTztBQUFBLE1BQ0wsQ0FBQyxnQkFBZ0IsU0FBUyxzQkFBc0I7QUFBQSxNQUNoRDtBQUFBLElBQ0Y7QUFHQSxXQUFPLFVBQVUsZ0JBQWdCLEtBQUssR0FBRztBQUFBLE1BQ3ZDO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRixDQUFDO0FBQUEsRUFDSCxDQUFDO0FBRUQsS0FBRywwREFBcUQsTUFBTTtBQUM1RCxVQUFNLE1BQU0sWUFBWSxLQUFLLE9BQU8sR0FBRywrQkFBK0IsQ0FBQztBQUN2RSxrQkFBYyxLQUFLLEtBQUssV0FBVyxHQUFHLEtBQUssVUFBVSxDQUFDLENBQUMsQ0FBQztBQUV4RCxVQUFNLGFBQWEsdUJBQXVCLEdBQUc7QUFDN0MsVUFBTSxTQUE4QjtBQUFBLE1BQ2xDLFdBQVc7QUFBQSxRQUNULGNBQWMsRUFBRSxpQkFBaUIsQ0FBQyxjQUFjLEVBQUU7QUFBQSxNQUNwRDtBQUFBLElBQ0Y7QUFFQSxVQUFNLGtCQUFrQjtBQUFBLE1BQ3RCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUVBLFdBQU8sVUFBVSxpQkFBaUIsQ0FBQyxHQUFHLCtDQUEwQztBQUFBLEVBQ2xGLENBQUM7QUFFRCxLQUFHLDRFQUF1RSxNQUFNO0FBQzlFLFVBQU0sTUFBTSxZQUFZLEtBQUssT0FBTyxHQUFHLGlDQUFpQyxDQUFDO0FBQ3pFO0FBQUEsTUFDRSxLQUFLLEtBQUssV0FBVztBQUFBLE1BQ3JCLEtBQUssVUFBVTtBQUFBLFFBQ2IsWUFBWSxFQUFFLFlBQVksQ0FBQyxHQUFHLFlBQVksQ0FBQyxHQUFHLFlBQVksQ0FBQyxFQUFFO0FBQUEsTUFDL0QsQ0FBQztBQUFBLElBQ0g7QUFFQSxVQUFNLGFBQWEsdUJBQXVCLEdBQUc7QUFDN0MsV0FBTyxNQUFNLFdBQVcsUUFBUSxDQUFDO0FBRWpDLFVBQU0sU0FBOEI7QUFBQSxNQUNsQyxXQUFXO0FBQUEsUUFDVCxnQkFBZ0IsRUFBRSxpQkFBaUIsQ0FBQyxVQUFVLEVBQUU7QUFBQSxNQUNsRDtBQUFBLElBQ0Y7QUFHQSxVQUFNLGtCQUFrQjtBQUFBLE1BQ3RCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUVBLFdBQU8sVUFBVSxpQkFBaUIsQ0FBQyxHQUFHLHdDQUF3QztBQUFBLEVBQ2hGLENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
