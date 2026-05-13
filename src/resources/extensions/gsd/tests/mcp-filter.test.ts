import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { discoverMcpServerNames, computeMcpDisallowedTools } from "../mcp-filter.ts";
import type { ClaudeCodeMcpConfig } from "../preferences-types.ts";

// ─── discoverMcpServerNames ────────────────────────────────────────────────

describe("discoverMcpServerNames", () => {
  it("reads server names from .mcp.json mcpServers keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-test-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "server-a": {}, "server-b": {} } }),
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
      JSON.stringify({ mcpServers: { "server-a": {}, "shared": {} } }),
    );
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { "server-b": {}, "shared": {} } }),
    );
    const result = discoverMcpServerNames(dir);
    assert.deepEqual(result.sort(), ["server-a", "server-b", "shared"]);
  });

  it("handles .claude/settings.json missing gracefully", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-filter-test-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "only-server": {} } }),
    );
    const result = discoverMcpServerNames(dir);
    assert.deepEqual(result, ["only-server"]);
  });
});

// ─── computeMcpDisallowedTools ─────────────────────────────────────────────

describe("computeMcpDisallowedTools", () => {
  it("returns [] when mcpConfig is undefined (no filtering)", () => {
    const result = computeMcpDisallowedTools(
      "claude-haiku-4-5-20251001",
      undefined,
      ["server-a", "server-b"],
      "gsd-workflow",
    );
    assert.deepEqual(result, []);
  });

  it("returns [] when no model prefix matches any config key", () => {
    const config: ClaudeCodeMcpConfig = {
      per_model: {
        "claude-haiku": { allowed_servers: ["server-a"] },
      },
    };
    const result = computeMcpDisallowedTools(
      "claude-opus-4-7",
      config,
      ["server-a", "server-b"],
      "gsd-workflow",
    );
    assert.deepEqual(result, []);
  });

  it("allowlist-only: blocks all discovered servers not in allowed_servers (R002)", () => {
    const config: ClaudeCodeMcpConfig = {
      per_model: {
        "claude-haiku": { allowed_servers: ["server-a"] },
      },
    };
    const result = computeMcpDisallowedTools(
      "claude-haiku-4-5-20251001",
      config,
      ["server-a", "server-b", "server-c"],
      "gsd-workflow",
    );
    assert.deepEqual(result.sort(), ["mcp__server-b__*", "mcp__server-c__*"]);
  });

  it("blocklist-only: blocks only servers in blocked_servers (R002)", () => {
    const config: ClaudeCodeMcpConfig = {
      per_model: {
        "claude-haiku": { blocked_servers: ["server-b"] },
      },
    };
    const result = computeMcpDisallowedTools(
      "claude-haiku-4-5-20251001",
      config,
      ["server-a", "server-b", "server-c"],
      "gsd-workflow",
    );
    assert.deepEqual(result, ["mcp__server-b__*"]);
  });

  it("both lists: allowlist applies first, then blocklist removes; blocklist wins on overlap (R002)", () => {
    const config: ClaudeCodeMcpConfig = {
      per_model: {
        "claude-haiku": {
          allowed_servers: ["server-a", "server-b"],
          blocked_servers: ["server-b"],
        },
      },
    };
    const result = computeMcpDisallowedTools(
      "claude-haiku-4-5-20251001",
      config,
      ["server-a", "server-b", "server-c"],
      "gsd-workflow",
    );
    // server-c blocked by allowlist, server-b blocked by blocklist (wins over allowlist)
    assert.deepEqual(result.sort(), ["mcp__server-b__*", "mcp__server-c__*"]);
  });

  it("gsd-workflow implicitly allowed even when not in allowlist (R003)", () => {
    const config: ClaudeCodeMcpConfig = {
      per_model: {
        "claude-haiku": { allowed_servers: ["server-a"] },
      },
    };
    const result = computeMcpDisallowedTools(
      "claude-haiku-4-5-20251001",
      config,
      ["server-a", "server-b"],
      "gsd-workflow",
    );
    assert.ok(!result.includes("mcp__gsd-workflow__*"), "gsd-workflow must not be blocked");
    assert.deepEqual(result, ["mcp__server-b__*"]);
  });

  it("gsd-workflow blocked when explicitly in blocked_servers (R003 override)", () => {
    const config: ClaudeCodeMcpConfig = {
      per_model: {
        "claude-haiku": { blocked_servers: ["gsd-workflow"] },
      },
    };
    const result = computeMcpDisallowedTools(
      "claude-haiku-4-5-20251001",
      config,
      ["server-a"],
      "gsd-workflow",
    );
    assert.ok(result.includes("mcp__gsd-workflow__*"), "gsd-workflow must be blocked");
  });

  it("returns mcp__<name>__* pattern format for each blocked server (R006)", () => {
    const config: ClaudeCodeMcpConfig = {
      per_model: {
        "claude-haiku": { blocked_servers: ["my-server", "other-server"] },
      },
    };
    const result = computeMcpDisallowedTools(
      "claude-haiku-4-5-20251001",
      config,
      ["my-server", "other-server"],
      "gsd-workflow",
    );
    assert.deepEqual(result.sort(), ["mcp__my-server__*", "mcp__other-server__*"]);
  });
});
