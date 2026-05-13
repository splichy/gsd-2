import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ChannelType } from "discord.js";
import { isAuthorized, validateDiscordConfig } from "./discord-bot.js";
import { sanitizeChannelName, ChannelManager } from "./channel-manager.js";
import { buildCommands, formatSessionStatus } from "./commands.js";
import { Daemon } from "./daemon.js";
import { Logger } from "./logger.js";
import { validateConfig } from "./config.js";
function tmpDir() {
  return mkdtempSync(join(tmpdir(), `discord-test-${randomUUID().slice(0, 8)}-`));
}
const cleanupDirs = [];
afterEach(() => {
  while (cleanupDirs.length) {
    const d = cleanupDirs.pop();
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});
describe("isAuthorized", () => {
  it("returns true when userId matches ownerId", () => {
    assert.equal(isAuthorized("12345", "12345"), true);
  });
  it("returns false when userId does not match ownerId", () => {
    assert.equal(isAuthorized("12345", "99999"), false);
  });
  it("returns false when ownerId is empty", () => {
    assert.equal(isAuthorized("12345", ""), false);
  });
  it("returns false when userId is empty", () => {
    assert.equal(isAuthorized("", "12345"), false);
  });
  it("returns false when both are empty", () => {
    assert.equal(isAuthorized("", ""), false);
  });
});
describe("validateDiscordConfig", () => {
  it("passes with all required fields", () => {
    assert.doesNotThrow(() => {
      validateDiscordConfig({
        token: "test-token",
        guild_id: "g123",
        owner_id: "o456"
      });
    });
  });
  it("throws on undefined config", () => {
    assert.throws(
      () => validateDiscordConfig(void 0),
      (err) => {
        assert.ok(err.message.includes("undefined"));
        return true;
      }
    );
  });
  it("throws on missing token", () => {
    assert.throws(
      () => validateDiscordConfig({ token: "", guild_id: "g1", owner_id: "o1" }),
      (err) => {
        assert.ok(err.message.includes("token"));
        return true;
      }
    );
  });
  it("throws on whitespace-only token", () => {
    assert.throws(
      () => validateDiscordConfig({ token: "   ", guild_id: "g1", owner_id: "o1" }),
      (err) => {
        assert.ok(err.message.includes("token"));
        return true;
      }
    );
  });
  it("throws on missing guild_id", () => {
    assert.throws(
      () => validateDiscordConfig({ token: "tok", guild_id: "", owner_id: "o1" }),
      (err) => {
        assert.ok(err.message.includes("guild_id"));
        return true;
      }
    );
  });
  it("throws on missing owner_id", () => {
    assert.throws(
      () => validateDiscordConfig({ token: "tok", guild_id: "g1", owner_id: "" }),
      (err) => {
        assert.ok(err.message.includes("owner_id"));
        return true;
      }
    );
  });
});
describe("Daemon + DiscordBot wiring", () => {
  it("does not create DiscordBot when discord config is absent", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, "no-discord.log");
    const config = {
      discord: void 0,
      projects: { scan_roots: [] },
      log: { file: logPath, level: "debug", max_size_mb: 50 }
    };
    const logger = new Logger({ filePath: logPath, level: "debug" });
    const daemon = new Daemon(config, logger);
    await daemon.start();
    const origExit = process.exit;
    process.exit = () => {
    };
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }
    const content = readFileSync(logPath, "utf-8");
    assert.ok(!content.includes("bot ready"));
    assert.ok(!content.includes("discord bot login failed"));
    assert.ok(!content.includes("bot destroyed"));
  });
  it("logs error when discord config has token but login fails (no real gateway)", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, "bad-token.log");
    const config = {
      discord: {
        token: "invalid-token-that-will-fail-login",
        guild_id: "g1",
        owner_id: "o1"
      },
      projects: { scan_roots: [] },
      log: { file: logPath, level: "debug", max_size_mb: 50 }
    };
    const logger = new Logger({ filePath: logPath, level: "debug" });
    const daemon = new Daemon(config, logger);
    await daemon.start();
    const origExit = process.exit;
    process.exit = () => {
    };
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }
    await new Promise((r) => setTimeout(r, 50));
    const content = readFileSync(logPath, "utf-8");
    assert.ok(content.includes("discord bot login failed"), "should log bot login failure");
    assert.ok(!content.includes("invalid-token-that-will-fail-login"), "token must not appear in logs");
  });
  it("does not attempt login when discord config has no token", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, "no-token.log");
    const config = {
      discord: {
        token: "",
        guild_id: "g1",
        owner_id: "o1"
      },
      projects: { scan_roots: [] },
      log: { file: logPath, level: "debug", max_size_mb: 50 }
    };
    const logger = new Logger({ filePath: logPath, level: "debug" });
    const daemon = new Daemon(config, logger);
    await daemon.start();
    const origExit = process.exit;
    process.exit = () => {
    };
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }
    const content = readFileSync(logPath, "utf-8");
    assert.ok(!content.includes("discord bot login failed"));
    assert.ok(!content.includes("bot ready"));
  });
});
describe("sanitizeChannelName", () => {
  it("converts basic path to gsd-prefixed name", () => {
    assert.equal(sanitizeChannelName("/home/user/my-project"), "gsd-my-project");
  });
  it("converts path with special characters to hyphens", () => {
    assert.equal(sanitizeChannelName("/home/user/My_Cool.Project!v2"), "gsd-my-cool-project-v2");
  });
  it("truncates very long names to 100 chars", () => {
    const longName = "a".repeat(200);
    const result = sanitizeChannelName(`/home/${longName}`);
    assert.ok(result.length <= 100, `Expected <= 100 chars, got ${result.length}`);
    assert.ok(result.startsWith("gsd-"));
  });
  it("cleans leading/trailing dots and underscores", () => {
    assert.equal(sanitizeChannelName("/home/...___project___..."), "gsd-project");
  });
  it("returns gsd-unnamed for empty basename", () => {
    assert.equal(sanitizeChannelName(""), "gsd-unnamed");
    assert.equal(sanitizeChannelName("/"), "gsd-unnamed");
  });
  it("returns gsd-unnamed for basename with only special chars", () => {
    assert.equal(sanitizeChannelName("/home/!!!"), "gsd-unnamed");
  });
  it("collapses consecutive hyphens", () => {
    assert.equal(sanitizeChannelName("/home/a---b---c"), "gsd-a-b-c");
  });
  it("handles Windows-style backslash paths", () => {
    assert.equal(sanitizeChannelName("C:\\Users\\lex\\my-project"), "gsd-my-project");
  });
  it("handles name at exact prefix + 96 chars = 100 char limit", () => {
    const name96 = "a".repeat(96);
    const result = sanitizeChannelName(`/home/${name96}`);
    assert.equal(result.length, 100);
    assert.equal(result, `gsd-${"a".repeat(96)}`);
  });
  it("handles whitespace-only basename", () => {
    assert.equal(sanitizeChannelName("/home/   "), "gsd-unnamed");
  });
});
describe("ChannelManager", () => {
  function createMockGuild() {
    const channels = /* @__PURE__ */ new Map();
    let createCounter = 0;
    const mockGuild = {
      id: "guild-123",
      // @everyone role ID matches guild ID
      channels: {
        cache: {
          get: (id) => channels.get(id),
          find: (fn) => {
            for (const ch of channels.values()) {
              if (fn(ch)) return ch;
            }
            return void 0;
          }
        },
        create: async (opts) => {
          createCounter++;
          const id = `chan-${createCounter}`;
          const ch = {
            id,
            name: opts.name,
            type: opts.type,
            parentId: opts.parent ?? null,
            edit: async (editOpts) => {
              ch.parentId = editOpts.parent ?? ch.parentId;
              return ch;
            }
          };
          channels.set(id, ch);
          return ch;
        }
      },
      _channels: channels,
      // internal for test inspection
      _getCreateCount: () => createCounter
    };
    return mockGuild;
  }
  function createMockLogger() {
    const entries = [];
    return {
      debug: (msg, data) => entries.push({ level: "debug", msg, data }),
      info: (msg, data) => entries.push({ level: "info", msg, data }),
      warn: (msg, data) => entries.push({ level: "warn", msg, data }),
      error: (msg, data) => entries.push({ level: "error", msg, data }),
      entries,
      close: async () => {
      }
    };
  }
  it("resolveCategory creates category when not found", async () => {
    const guild = createMockGuild();
    const logger = createMockLogger();
    const mgr = new ChannelManager({ guild, logger });
    const cat = await mgr.resolveCategory();
    assert.equal(cat.name, "GSD Projects");
    assert.equal(cat.type, ChannelType.GuildCategory);
  });
  it("resolveCategory returns cached category on second call", async () => {
    const guild = createMockGuild();
    const logger = createMockLogger();
    const mgr = new ChannelManager({ guild, logger });
    const cat1 = await mgr.resolveCategory();
    const cat2 = await mgr.resolveCategory();
    assert.equal(cat1.id, cat2.id);
    assert.equal(guild._getCreateCount(), 1);
  });
  it("resolveCategory finds existing category by name", async () => {
    const guild = createMockGuild();
    guild._channels.set("existing-cat", {
      id: "existing-cat",
      name: "GSD Projects",
      type: ChannelType.GuildCategory,
      parentId: null
    });
    const logger = createMockLogger();
    const mgr = new ChannelManager({ guild, logger });
    const cat = await mgr.resolveCategory();
    assert.equal(cat.id, "existing-cat");
    assert.equal(guild._getCreateCount(), 0);
  });
  it("createProjectChannel creates text channel under category", async () => {
    const guild = createMockGuild();
    const logger = createMockLogger();
    const mgr = new ChannelManager({ guild, logger });
    const channel = await mgr.createProjectChannel("/home/user/my-project");
    assert.equal(channel.name, "gsd-my-project");
    assert.equal(channel.type, ChannelType.GuildText);
    assert.equal(channel.parentId, "chan-1");
  });
  it("archiveChannel moves channel to archive category", async () => {
    const guild = createMockGuild();
    const logger = createMockLogger();
    const mgr = new ChannelManager({ guild, logger });
    const channel = await mgr.createProjectChannel("/home/user/project");
    const channelId = channel.id;
    await mgr.archiveChannel(channelId);
    const archived = guild._channels.get(channelId);
    assert.equal(archived.parentId, "chan-3");
    const archiveLog = logger.entries.find((e) => e.msg === "channel archived");
    assert.ok(archiveLog, "should log channel archived");
    assert.equal(archiveLog.data.channelId, channelId);
  });
  it("archiveChannel warns when channel not found", async () => {
    const guild = createMockGuild();
    const logger = createMockLogger();
    const mgr = new ChannelManager({ guild, logger });
    await mgr.archiveChannel("nonexistent-id");
    const warnLog = logger.entries.find((e) => e.msg === "archive target not found");
    assert.ok(warnLog, "should warn about missing channel");
  });
  it("uses custom category name when provided", async () => {
    const guild = createMockGuild();
    const logger = createMockLogger();
    const mgr = new ChannelManager({
      guild,
      logger,
      categoryName: "Custom Category"
    });
    const cat = await mgr.resolveCategory();
    assert.equal(cat.name, "Custom Category");
  });
});
describe("buildCommands", () => {
  it("returns array with correct command names", () => {
    const commands = buildCommands();
    assert.equal(commands.length, 4);
    const names = commands.map((c) => c.name);
    assert.ok(names.includes("gsd-status"), "should include gsd-status");
    assert.ok(names.includes("gsd-start"), "should include gsd-start");
    assert.ok(names.includes("gsd-stop"), "should include gsd-stop");
    assert.ok(names.includes("gsd-verbose"), "should include gsd-verbose");
  });
  it("each command has a description", () => {
    const commands = buildCommands();
    for (const cmd of commands) {
      assert.ok(cmd.description, `command ${cmd.name} should have a description`);
      assert.ok(cmd.description.length > 0, `command ${cmd.name} description should be non-empty`);
    }
  });
});
describe("formatSessionStatus", () => {
  function mockSession(overrides = {}) {
    return {
      sessionId: "sess-1",
      projectDir: "/home/user/project",
      projectName: "project",
      status: "running",
      client: {},
      events: [],
      pendingBlocker: null,
      cost: { totalCost: 0.1234, tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
      startTime: Date.now() - 12e4,
      // 2 minutes ago
      ...overrides
    };
  }
  it('returns "No active sessions." for empty array', () => {
    assert.equal(formatSessionStatus([]), "No active sessions.");
  });
  it("formats single session with project name and status", () => {
    const result = formatSessionStatus([mockSession()]);
    assert.ok(result.includes("project"), "should contain project name");
    assert.ok(result.includes("running"), "should contain status");
    assert.ok(result.includes("$"), "should contain cost");
  });
  it("formats multiple sessions on separate lines", () => {
    const sessions = [
      mockSession({ projectName: "alpha", status: "running" }),
      mockSession({ projectName: "beta", status: "blocked" })
    ];
    const result = formatSessionStatus(sessions);
    assert.ok(result.includes("alpha"), "should contain first project");
    assert.ok(result.includes("beta"), "should contain second project");
    const lines = result.split("\n");
    assert.equal(lines.length, 2, "should have one line per session");
  });
  it("formats 5 sessions correctly", () => {
    const sessions = Array.from(
      { length: 5 },
      (_, i) => mockSession({ projectName: `proj-${i}`, status: i % 2 === 0 ? "running" : "completed" })
    );
    const result = formatSessionStatus(sessions);
    const lines = result.split("\n");
    assert.equal(lines.length, 5);
    for (let i = 0; i < 5; i++) {
      assert.ok(lines[i].includes(`proj-${i}`));
    }
  });
});
describe("command dispatch", () => {
  function mockInteraction(commandName, userId = "owner-1") {
    let replied = false;
    let replyContent = "";
    return {
      user: { id: userId },
      type: 2,
      // InteractionType.ApplicationCommand
      isChatInputCommand: () => true,
      commandName,
      reply: async (opts) => {
        replied = true;
        replyContent = opts.content;
      },
      _getReplied: () => replied,
      _getReplyContent: () => replyContent
    };
  }
  function mockNonCommandInteraction(userId = "owner-1") {
    let replied = false;
    return {
      user: { id: userId },
      type: 3,
      // InteractionType.MessageComponent
      isChatInputCommand: () => false,
      _getReplied: () => replied
    };
  }
  it("gsd-status with no sessions produces empty message", () => {
    const result = formatSessionStatus([]);
    assert.equal(result, "No active sessions.");
  });
  it("unknown command name is not in buildCommands list", () => {
    const commands = buildCommands();
    const names = commands.map((c) => c.name);
    assert.ok(!names.includes("gsd-unknown"), "unknown should not be in command list");
  });
  it("auth guard rejects non-owner on interaction", () => {
    const authorized = isAuthorized("intruder-999", "owner-1");
    assert.equal(authorized, false);
  });
  it("auth guard accepts owner on interaction", () => {
    const authorized = isAuthorized("owner-1", "owner-1");
    assert.equal(authorized, true);
  });
});
describe("validateConfig \u2014 control_channel_id and orchestrator", () => {
  it("parses control_channel_id from discord block", () => {
    const config = validateConfig({
      discord: {
        token: "tok",
        guild_id: "g1",
        owner_id: "o1",
        control_channel_id: "ch-123"
      }
    });
    assert.equal(config.discord?.control_channel_id, "ch-123");
  });
  it("omits control_channel_id when not present", () => {
    const config = validateConfig({
      discord: {
        token: "tok",
        guild_id: "g1",
        owner_id: "o1"
      }
    });
    assert.equal(config.discord?.control_channel_id, void 0);
  });
  it("parses orchestrator model and max_tokens", () => {
    const config = validateConfig({
      discord: {
        token: "tok",
        guild_id: "g1",
        owner_id: "o1",
        orchestrator: { model: "claude-opus-2025", max_tokens: 2048 }
      }
    });
    assert.equal(config.discord?.orchestrator?.model, "claude-opus-2025");
    assert.equal(config.discord?.orchestrator?.max_tokens, 2048);
  });
  it("missing orchestrator block results in undefined", () => {
    const config = validateConfig({
      discord: {
        token: "tok",
        guild_id: "g1",
        owner_id: "o1"
      }
    });
    assert.equal(config.discord?.orchestrator, void 0);
  });
  it("empty orchestrator block has no model or max_tokens", () => {
    const config = validateConfig({
      discord: {
        token: "tok",
        guild_id: "g1",
        owner_id: "o1",
        orchestrator: {}
      }
    });
    assert.ok(config.discord?.orchestrator !== void 0);
    assert.equal(config.discord?.orchestrator?.model, void 0);
    assert.equal(config.discord?.orchestrator?.max_tokens, void 0);
  });
  it("ignores non-numeric max_tokens", () => {
    const config = validateConfig({
      discord: {
        token: "tok",
        guild_id: "g1",
        owner_id: "o1",
        orchestrator: { max_tokens: "not a number" }
      }
    });
    assert.equal(config.discord?.orchestrator?.max_tokens, void 0);
  });
  it("ignores non-string model", () => {
    const config = validateConfig({
      discord: {
        token: "tok",
        guild_id: "g1",
        owner_id: "o1",
        orchestrator: { model: 42 }
      }
    });
    assert.equal(config.discord?.orchestrator?.model, void 0);
  });
});
describe("Daemon orchestrator wiring", () => {
  it("orchestrator is undefined when control_channel_id is not set", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, "no-orchestrator.log");
    const config = {
      discord: void 0,
      projects: { scan_roots: [] },
      log: { file: logPath, level: "debug", max_size_mb: 50 }
    };
    const logger = new Logger({ filePath: logPath, level: "debug" });
    const daemon = new Daemon(config, logger);
    await daemon.start();
    assert.equal(daemon.getOrchestrator(), void 0);
    const origExit = process.exit;
    process.exit = () => {
    };
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }
  });
  it("orchestrator is undefined when discord has no control_channel_id", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, "no-ctl-chan.log");
    const config = {
      discord: {
        token: "bad-token",
        guild_id: "g1",
        owner_id: "o1"
        // control_channel_id intentionally omitted
      },
      projects: { scan_roots: [] },
      log: { file: logPath, level: "debug", max_size_mb: 50 }
    };
    const logger = new Logger({ filePath: logPath, level: "debug" });
    const daemon = new Daemon(config, logger);
    await daemon.start();
    assert.equal(daemon.getOrchestrator(), void 0);
    const origExit = process.exit;
    process.exit = () => {
    };
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }
  });
});
describe("/gsd-start and /gsd-stop logic", () => {
  it("/gsd-start: scanForProjects returning 0 projects", async () => {
    const { scanForProjects } = await import("./project-scanner.js");
    const projects = await scanForProjects([]);
    assert.equal(projects.length, 0);
  });
  it("/gsd-stop: getAllSessions returns empty when no sessions active", async () => {
    const { SessionManager } = await import("./session-manager.js");
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, "sm-test.log");
    const logger = new Logger({ filePath: logPath, level: "debug" });
    const sm = new SessionManager(logger);
    const sessions = sm.getAllSessions();
    assert.equal(sessions.length, 0);
    await logger.close();
  });
  it("/gsd-stop: filters to active sessions only", () => {
    const allSessions = [
      { sessionId: "s1", status: "running", projectName: "alpha" },
      { sessionId: "s2", status: "completed", projectName: "beta" },
      { sessionId: "s3", status: "blocked", projectName: "gamma" },
      { sessionId: "s4", status: "error", projectName: "delta" },
      { sessionId: "s5", status: "starting", projectName: "epsilon" },
      { sessionId: "s6", status: "cancelled", projectName: "zeta" }
    ];
    const active = allSessions.filter(
      (s) => s.status === "running" || s.status === "blocked" || s.status === "starting"
    );
    assert.equal(active.length, 3);
    assert.deepEqual(active.map((s) => s.projectName), ["alpha", "gamma", "epsilon"]);
  });
  it("/gsd-start: >25 projects are truncated for select menu", () => {
    const projects = Array.from({ length: 30 }, (_, i) => ({
      name: `project-${i}`,
      path: `/home/user/project-${i}`,
      markers: [],
      lastModified: Date.now()
    }));
    const truncated = projects.slice(0, 25);
    assert.equal(truncated.length, 25);
    assert.equal(truncated[24].name, "project-24");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvZGFlbW9uL3NyYy9kaXNjb3JkLWJvdC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBkZXNjcmliZSwgaXQsIGFmdGVyRWFjaCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgcmVhZEZpbGVTeW5jLCBybVN5bmMsIGV4aXN0c1N5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xuaW1wb3J0IHsgQ2hhbm5lbFR5cGUgfSBmcm9tICdkaXNjb3JkLmpzJztcbmltcG9ydCB7IGlzQXV0aG9yaXplZCwgdmFsaWRhdGVEaXNjb3JkQ29uZmlnIH0gZnJvbSAnLi9kaXNjb3JkLWJvdC5qcyc7XG5pbXBvcnQgeyBzYW5pdGl6ZUNoYW5uZWxOYW1lLCBDaGFubmVsTWFuYWdlciB9IGZyb20gJy4vY2hhbm5lbC1tYW5hZ2VyLmpzJztcbmltcG9ydCB7IGJ1aWxkQ29tbWFuZHMsIGZvcm1hdFNlc3Npb25TdGF0dXMgfSBmcm9tICcuL2NvbW1hbmRzLmpzJztcbmltcG9ydCB7IERhZW1vbiB9IGZyb20gJy4vZGFlbW9uLmpzJztcbmltcG9ydCB7IExvZ2dlciB9IGZyb20gJy4vbG9nZ2VyLmpzJztcbmltcG9ydCB7IHZhbGlkYXRlQ29uZmlnIH0gZnJvbSAnLi9jb25maWcuanMnO1xuaW1wb3J0IHR5cGUgeyBEYWVtb25Db25maWcsIExvZ0VudHJ5LCBNYW5hZ2VkU2Vzc2lvbiB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG4vLyAtLS0tLS0tLS0tIGhlbHBlcnMgLS0tLS0tLS0tLVxuXG5mdW5jdGlvbiB0bXBEaXIoKTogc3RyaW5nIHtcbiAgcmV0dXJuIG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIGBkaXNjb3JkLXRlc3QtJHtyYW5kb21VVUlEKCkuc2xpY2UoMCwgOCl9LWApKTtcbn1cblxuY29uc3QgY2xlYW51cERpcnM6IHN0cmluZ1tdID0gW107XG5hZnRlckVhY2goKCkgPT4ge1xuICB3aGlsZSAoY2xlYW51cERpcnMubGVuZ3RoKSB7XG4gICAgY29uc3QgZCA9IGNsZWFudXBEaXJzLnBvcCgpITtcbiAgICBpZiAoZXhpc3RzU3luYyhkKSkgcm1TeW5jKGQsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbi8vIC0tLS0tLS0tLS0gaXNBdXRob3JpemVkIC0tLS0tLS0tLS1cblxuZGVzY3JpYmUoJ2lzQXV0aG9yaXplZCcsICgpID0+IHtcbiAgaXQoJ3JldHVybnMgdHJ1ZSB3aGVuIHVzZXJJZCBtYXRjaGVzIG93bmVySWQnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKGlzQXV0aG9yaXplZCgnMTIzNDUnLCAnMTIzNDUnKSwgdHJ1ZSk7XG4gIH0pO1xuXG4gIGl0KCdyZXR1cm5zIGZhbHNlIHdoZW4gdXNlcklkIGRvZXMgbm90IG1hdGNoIG93bmVySWQnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKGlzQXV0aG9yaXplZCgnMTIzNDUnLCAnOTk5OTknKSwgZmFsc2UpO1xuICB9KTtcblxuICBpdCgncmV0dXJucyBmYWxzZSB3aGVuIG93bmVySWQgaXMgZW1wdHknLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKGlzQXV0aG9yaXplZCgnMTIzNDUnLCAnJyksIGZhbHNlKTtcbiAgfSk7XG5cbiAgaXQoJ3JldHVybnMgZmFsc2Ugd2hlbiB1c2VySWQgaXMgZW1wdHknLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKGlzQXV0aG9yaXplZCgnJywgJzEyMzQ1JyksIGZhbHNlKTtcbiAgfSk7XG5cbiAgaXQoJ3JldHVybnMgZmFsc2Ugd2hlbiBib3RoIGFyZSBlbXB0eScsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoaXNBdXRob3JpemVkKCcnLCAnJyksIGZhbHNlKTtcbiAgfSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLSB2YWxpZGF0ZURpc2NvcmRDb25maWcgLS0tLS0tLS0tLVxuXG5kZXNjcmliZSgndmFsaWRhdGVEaXNjb3JkQ29uZmlnJywgKCkgPT4ge1xuICBpdCgncGFzc2VzIHdpdGggYWxsIHJlcXVpcmVkIGZpZWxkcycsICgpID0+IHtcbiAgICBhc3NlcnQuZG9lc05vdFRocm93KCgpID0+IHtcbiAgICAgIHZhbGlkYXRlRGlzY29yZENvbmZpZyh7XG4gICAgICAgIHRva2VuOiAndGVzdC10b2tlbicsXG4gICAgICAgIGd1aWxkX2lkOiAnZzEyMycsXG4gICAgICAgIG93bmVyX2lkOiAnbzQ1NicsXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgaXQoJ3Rocm93cyBvbiB1bmRlZmluZWQgY29uZmlnJywgKCkgPT4ge1xuICAgIGFzc2VydC50aHJvd3MoXG4gICAgICAoKSA9PiB2YWxpZGF0ZURpc2NvcmRDb25maWcodW5kZWZpbmVkKSxcbiAgICAgIChlcnI6IEVycm9yKSA9PiB7XG4gICAgICAgIGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcygndW5kZWZpbmVkJykpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0sXG4gICAgKTtcbiAgfSk7XG5cbiAgaXQoJ3Rocm93cyBvbiBtaXNzaW5nIHRva2VuJywgKCkgPT4ge1xuICAgIGFzc2VydC50aHJvd3MoXG4gICAgICAoKSA9PiB2YWxpZGF0ZURpc2NvcmRDb25maWcoeyB0b2tlbjogJycsIGd1aWxkX2lkOiAnZzEnLCBvd25lcl9pZDogJ28xJyB9KSxcbiAgICAgIChlcnI6IEVycm9yKSA9PiB7XG4gICAgICAgIGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcygndG9rZW4nKSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICApO1xuICB9KTtcblxuICBpdCgndGhyb3dzIG9uIHdoaXRlc3BhY2Utb25seSB0b2tlbicsICgpID0+IHtcbiAgICBhc3NlcnQudGhyb3dzKFxuICAgICAgKCkgPT4gdmFsaWRhdGVEaXNjb3JkQ29uZmlnKHsgdG9rZW46ICcgICAnLCBndWlsZF9pZDogJ2cxJywgb3duZXJfaWQ6ICdvMScgfSksXG4gICAgICAoZXJyOiBFcnJvcikgPT4ge1xuICAgICAgICBhc3NlcnQub2soZXJyLm1lc3NhZ2UuaW5jbHVkZXMoJ3Rva2VuJykpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0sXG4gICAgKTtcbiAgfSk7XG5cbiAgaXQoJ3Rocm93cyBvbiBtaXNzaW5nIGd1aWxkX2lkJywgKCkgPT4ge1xuICAgIGFzc2VydC50aHJvd3MoXG4gICAgICAoKSA9PiB2YWxpZGF0ZURpc2NvcmRDb25maWcoeyB0b2tlbjogJ3RvaycsIGd1aWxkX2lkOiAnJywgb3duZXJfaWQ6ICdvMScgfSksXG4gICAgICAoZXJyOiBFcnJvcikgPT4ge1xuICAgICAgICBhc3NlcnQub2soZXJyLm1lc3NhZ2UuaW5jbHVkZXMoJ2d1aWxkX2lkJykpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0sXG4gICAgKTtcbiAgfSk7XG5cbiAgaXQoJ3Rocm93cyBvbiBtaXNzaW5nIG93bmVyX2lkJywgKCkgPT4ge1xuICAgIGFzc2VydC50aHJvd3MoXG4gICAgICAoKSA9PiB2YWxpZGF0ZURpc2NvcmRDb25maWcoeyB0b2tlbjogJ3RvaycsIGd1aWxkX2lkOiAnZzEnLCBvd25lcl9pZDogJycgfSksXG4gICAgICAoZXJyOiBFcnJvcikgPT4ge1xuICAgICAgICBhc3NlcnQub2soZXJyLm1lc3NhZ2UuaW5jbHVkZXMoJ293bmVyX2lkJykpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0sXG4gICAgKTtcbiAgfSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLSBEYWVtb24gd2lyaW5nIC0tLS0tLS0tLS1cblxuZGVzY3JpYmUoJ0RhZW1vbiArIERpc2NvcmRCb3Qgd2lyaW5nJywgKCkgPT4ge1xuICBpdCgnZG9lcyBub3QgY3JlYXRlIERpc2NvcmRCb3Qgd2hlbiBkaXNjb3JkIGNvbmZpZyBpcyBhYnNlbnQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgZGlyID0gdG1wRGlyKCk7XG4gICAgY2xlYW51cERpcnMucHVzaChkaXIpO1xuICAgIGNvbnN0IGxvZ1BhdGggPSBqb2luKGRpciwgJ25vLWRpc2NvcmQubG9nJyk7XG5cbiAgICBjb25zdCBjb25maWc6IERhZW1vbkNvbmZpZyA9IHtcbiAgICAgIGRpc2NvcmQ6IHVuZGVmaW5lZCxcbiAgICAgIHByb2plY3RzOiB7IHNjYW5fcm9vdHM6IFtdIH0sXG4gICAgICBsb2c6IHsgZmlsZTogbG9nUGF0aCwgbGV2ZWw6ICdkZWJ1ZycsIG1heF9zaXplX21iOiA1MCB9LFxuICAgIH07XG5cbiAgICBjb25zdCBsb2dnZXIgPSBuZXcgTG9nZ2VyKHsgZmlsZVBhdGg6IGxvZ1BhdGgsIGxldmVsOiAnZGVidWcnIH0pO1xuICAgIGNvbnN0IGRhZW1vbiA9IG5ldyBEYWVtb24oY29uZmlnLCBsb2dnZXIpO1xuXG4gICAgYXdhaXQgZGFlbW9uLnN0YXJ0KCk7XG5cbiAgICBjb25zdCBvcmlnRXhpdCA9IHByb2Nlc3MuZXhpdDtcbiAgICAvLyBAdHMtZXhwZWN0LWVycm9yIFx1MjAxNCBvdmVycmlkaW5nIHByb2Nlc3MuZXhpdCBmb3IgdGVzdFxuICAgIHByb2Nlc3MuZXhpdCA9ICgpID0+IHt9O1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBkYWVtb24uc2h1dGRvd24oKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcHJvY2Vzcy5leGl0ID0gb3JpZ0V4aXQ7XG4gICAgfVxuXG4gICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhsb2dQYXRoLCAndXRmLTgnKTtcbiAgICAvLyBTaG91bGQgTk9UIGhhdmUgYW55IGJvdC1yZWxhdGVkIGxvZyBlbnRyaWVzXG4gICAgYXNzZXJ0Lm9rKCFjb250ZW50LmluY2x1ZGVzKCdib3QgcmVhZHknKSk7XG4gICAgYXNzZXJ0Lm9rKCFjb250ZW50LmluY2x1ZGVzKCdkaXNjb3JkIGJvdCBsb2dpbiBmYWlsZWQnKSk7XG4gICAgYXNzZXJ0Lm9rKCFjb250ZW50LmluY2x1ZGVzKCdib3QgZGVzdHJveWVkJykpO1xuICB9KTtcblxuICBpdCgnbG9ncyBlcnJvciB3aGVuIGRpc2NvcmQgY29uZmlnIGhhcyB0b2tlbiBidXQgbG9naW4gZmFpbHMgKG5vIHJlYWwgZ2F0ZXdheSknLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgZGlyID0gdG1wRGlyKCk7XG4gICAgY2xlYW51cERpcnMucHVzaChkaXIpO1xuICAgIGNvbnN0IGxvZ1BhdGggPSBqb2luKGRpciwgJ2JhZC10b2tlbi5sb2cnKTtcblxuICAgIGNvbnN0IGNvbmZpZzogRGFlbW9uQ29uZmlnID0ge1xuICAgICAgZGlzY29yZDoge1xuICAgICAgICB0b2tlbjogJ2ludmFsaWQtdG9rZW4tdGhhdC13aWxsLWZhaWwtbG9naW4nLFxuICAgICAgICBndWlsZF9pZDogJ2cxJyxcbiAgICAgICAgb3duZXJfaWQ6ICdvMScsXG4gICAgICB9LFxuICAgICAgcHJvamVjdHM6IHsgc2Nhbl9yb290czogW10gfSxcbiAgICAgIGxvZzogeyBmaWxlOiBsb2dQYXRoLCBsZXZlbDogJ2RlYnVnJywgbWF4X3NpemVfbWI6IDUwIH0sXG4gICAgfTtcblxuICAgIGNvbnN0IGxvZ2dlciA9IG5ldyBMb2dnZXIoeyBmaWxlUGF0aDogbG9nUGF0aCwgbGV2ZWw6ICdkZWJ1ZycgfSk7XG4gICAgY29uc3QgZGFlbW9uID0gbmV3IERhZW1vbihjb25maWcsIGxvZ2dlcik7XG5cbiAgICAvLyBzdGFydCgpIHNob3VsZCBOT1QgdGhyb3cgXHUyMDE0IGJvdCBsb2dpbiBmYWlsdXJlIGlzIG5vbi1mYXRhbFxuICAgIGF3YWl0IGRhZW1vbi5zdGFydCgpO1xuXG4gICAgY29uc3Qgb3JpZ0V4aXQgPSBwcm9jZXNzLmV4aXQ7XG4gICAgLy8gQHRzLWV4cGVjdC1lcnJvciBcdTIwMTQgb3ZlcnJpZGluZyBwcm9jZXNzLmV4aXQgZm9yIHRlc3RcbiAgICBwcm9jZXNzLmV4aXQgPSAoKSA9PiB7fTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgZGFlbW9uLnNodXRkb3duKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHByb2Nlc3MuZXhpdCA9IG9yaWdFeGl0O1xuICAgIH1cblxuICAgIC8vIFNtYWxsIGZsdXNoIGRlbGF5XG4gICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcblxuICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMobG9nUGF0aCwgJ3V0Zi04Jyk7XG4gICAgLy8gU2hvdWxkIGhhdmUgbG9nZ2VkIHRoZSBsb2dpbiBmYWlsdXJlXG4gICAgYXNzZXJ0Lm9rKGNvbnRlbnQuaW5jbHVkZXMoJ2Rpc2NvcmQgYm90IGxvZ2luIGZhaWxlZCcpLCAnc2hvdWxkIGxvZyBib3QgbG9naW4gZmFpbHVyZScpO1xuICAgIC8vIFRva2VuIHNob3VsZCBuZXZlciBhcHBlYXIgaW4gbG9nc1xuICAgIGFzc2VydC5vayghY29udGVudC5pbmNsdWRlcygnaW52YWxpZC10b2tlbi10aGF0LXdpbGwtZmFpbC1sb2dpbicpLCAndG9rZW4gbXVzdCBub3QgYXBwZWFyIGluIGxvZ3MnKTtcbiAgfSk7XG5cbiAgaXQoJ2RvZXMgbm90IGF0dGVtcHQgbG9naW4gd2hlbiBkaXNjb3JkIGNvbmZpZyBoYXMgbm8gdG9rZW4nLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgZGlyID0gdG1wRGlyKCk7XG4gICAgY2xlYW51cERpcnMucHVzaChkaXIpO1xuICAgIGNvbnN0IGxvZ1BhdGggPSBqb2luKGRpciwgJ25vLXRva2VuLmxvZycpO1xuXG4gICAgLy8gQ29uZmlnIHdpdGggZGlzY29yZCBibG9jayBidXQgZW1wdHkgdG9rZW5cbiAgICBjb25zdCBjb25maWc6IERhZW1vbkNvbmZpZyA9IHtcbiAgICAgIGRpc2NvcmQ6IHtcbiAgICAgICAgdG9rZW46ICcnLFxuICAgICAgICBndWlsZF9pZDogJ2cxJyxcbiAgICAgICAgb3duZXJfaWQ6ICdvMScsXG4gICAgICB9LFxuICAgICAgcHJvamVjdHM6IHsgc2Nhbl9yb290czogW10gfSxcbiAgICAgIGxvZzogeyBmaWxlOiBsb2dQYXRoLCBsZXZlbDogJ2RlYnVnJywgbWF4X3NpemVfbWI6IDUwIH0sXG4gICAgfTtcblxuICAgIGNvbnN0IGxvZ2dlciA9IG5ldyBMb2dnZXIoeyBmaWxlUGF0aDogbG9nUGF0aCwgbGV2ZWw6ICdkZWJ1ZycgfSk7XG4gICAgY29uc3QgZGFlbW9uID0gbmV3IERhZW1vbihjb25maWcsIGxvZ2dlcik7XG5cbiAgICBhd2FpdCBkYWVtb24uc3RhcnQoKTtcblxuICAgIGNvbnN0IG9yaWdFeGl0ID0gcHJvY2Vzcy5leGl0O1xuICAgIC8vIEB0cy1leHBlY3QtZXJyb3IgXHUyMDE0IG92ZXJyaWRpbmcgcHJvY2Vzcy5leGl0IGZvciB0ZXN0XG4gICAgcHJvY2Vzcy5leGl0ID0gKCkgPT4ge307XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGRhZW1vbi5zaHV0ZG93bigpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmV4aXQgPSBvcmlnRXhpdDtcbiAgICB9XG5cbiAgICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGxvZ1BhdGgsICd1dGYtOCcpO1xuICAgIC8vIFNob3VsZCBub3QgYXR0ZW1wdCBsb2dpbiBcdTIwMTQgbm8gdG9rZW5cbiAgICBhc3NlcnQub2soIWNvbnRlbnQuaW5jbHVkZXMoJ2Rpc2NvcmQgYm90IGxvZ2luIGZhaWxlZCcpKTtcbiAgICBhc3NlcnQub2soIWNvbnRlbnQuaW5jbHVkZXMoJ2JvdCByZWFkeScpKTtcbiAgfSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLSBzYW5pdGl6ZUNoYW5uZWxOYW1lIC0tLS0tLS0tLS1cblxuZGVzY3JpYmUoJ3Nhbml0aXplQ2hhbm5lbE5hbWUnLCAoKSA9PiB7XG4gIGl0KCdjb252ZXJ0cyBiYXNpYyBwYXRoIHRvIGdzZC1wcmVmaXhlZCBuYW1lJywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChzYW5pdGl6ZUNoYW5uZWxOYW1lKCcvaG9tZS91c2VyL215LXByb2plY3QnKSwgJ2dzZC1teS1wcm9qZWN0Jyk7XG4gIH0pO1xuXG4gIGl0KCdjb252ZXJ0cyBwYXRoIHdpdGggc3BlY2lhbCBjaGFyYWN0ZXJzIHRvIGh5cGhlbnMnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHNhbml0aXplQ2hhbm5lbE5hbWUoJy9ob21lL3VzZXIvTXlfQ29vbC5Qcm9qZWN0IXYyJyksICdnc2QtbXktY29vbC1wcm9qZWN0LXYyJyk7XG4gIH0pO1xuXG4gIGl0KCd0cnVuY2F0ZXMgdmVyeSBsb25nIG5hbWVzIHRvIDEwMCBjaGFycycsICgpID0+IHtcbiAgICBjb25zdCBsb25nTmFtZSA9ICdhJy5yZXBlYXQoMjAwKTtcbiAgICBjb25zdCByZXN1bHQgPSBzYW5pdGl6ZUNoYW5uZWxOYW1lKGAvaG9tZS8ke2xvbmdOYW1lfWApO1xuICAgIGFzc2VydC5vayhyZXN1bHQubGVuZ3RoIDw9IDEwMCwgYEV4cGVjdGVkIDw9IDEwMCBjaGFycywgZ290ICR7cmVzdWx0Lmxlbmd0aH1gKTtcbiAgICBhc3NlcnQub2socmVzdWx0LnN0YXJ0c1dpdGgoJ2dzZC0nKSk7XG4gIH0pO1xuXG4gIGl0KCdjbGVhbnMgbGVhZGluZy90cmFpbGluZyBkb3RzIGFuZCB1bmRlcnNjb3JlcycsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoc2FuaXRpemVDaGFubmVsTmFtZSgnL2hvbWUvLi4uX19fcHJvamVjdF9fXy4uLicpLCAnZ3NkLXByb2plY3QnKTtcbiAgfSk7XG5cbiAgaXQoJ3JldHVybnMgZ3NkLXVubmFtZWQgZm9yIGVtcHR5IGJhc2VuYW1lJywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChzYW5pdGl6ZUNoYW5uZWxOYW1lKCcnKSwgJ2dzZC11bm5hbWVkJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHNhbml0aXplQ2hhbm5lbE5hbWUoJy8nKSwgJ2dzZC11bm5hbWVkJyk7XG4gIH0pO1xuXG4gIGl0KCdyZXR1cm5zIGdzZC11bm5hbWVkIGZvciBiYXNlbmFtZSB3aXRoIG9ubHkgc3BlY2lhbCBjaGFycycsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoc2FuaXRpemVDaGFubmVsTmFtZSgnL2hvbWUvISEhJyksICdnc2QtdW5uYW1lZCcpO1xuICB9KTtcblxuICBpdCgnY29sbGFwc2VzIGNvbnNlY3V0aXZlIGh5cGhlbnMnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHNhbml0aXplQ2hhbm5lbE5hbWUoJy9ob21lL2EtLS1iLS0tYycpLCAnZ3NkLWEtYi1jJyk7XG4gIH0pO1xuXG4gIGl0KCdoYW5kbGVzIFdpbmRvd3Mtc3R5bGUgYmFja3NsYXNoIHBhdGhzJywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChzYW5pdGl6ZUNoYW5uZWxOYW1lKCdDOlxcXFxVc2Vyc1xcXFxsZXhcXFxcbXktcHJvamVjdCcpLCAnZ3NkLW15LXByb2plY3QnKTtcbiAgfSk7XG5cbiAgaXQoJ2hhbmRsZXMgbmFtZSBhdCBleGFjdCBwcmVmaXggKyA5NiBjaGFycyA9IDEwMCBjaGFyIGxpbWl0JywgKCkgPT4ge1xuICAgIC8vIGdzZC0gaXMgNCBjaGFycywgc28gYSA5Ni1jaGFyIGJhc2VuYW1lIHNob3VsZCBwcm9kdWNlIGV4YWN0bHkgMTAwXG4gICAgY29uc3QgbmFtZTk2ID0gJ2EnLnJlcGVhdCg5Nik7XG4gICAgY29uc3QgcmVzdWx0ID0gc2FuaXRpemVDaGFubmVsTmFtZShgL2hvbWUvJHtuYW1lOTZ9YCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5sZW5ndGgsIDEwMCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgYGdzZC0keydhJy5yZXBlYXQoOTYpfWApO1xuICB9KTtcblxuICBpdCgnaGFuZGxlcyB3aGl0ZXNwYWNlLW9ubHkgYmFzZW5hbWUnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHNhbml0aXplQ2hhbm5lbE5hbWUoJy9ob21lLyAgICcpLCAnZ3NkLXVubmFtZWQnKTtcbiAgfSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLSBDaGFubmVsTWFuYWdlciAtLS0tLS0tLS0tXG5cbmRlc2NyaWJlKCdDaGFubmVsTWFuYWdlcicsICgpID0+IHtcbiAgLy8gSGVscGVyIHRvIGNyZWF0ZSBhIG1vY2sgR3VpbGQgd2l0aCBjb250cm9sbGFibGUgY2hhbm5lbCBjYWNoZSBhbmQgY3JlYXRlIG1ldGhvZFxuICBmdW5jdGlvbiBjcmVhdGVNb2NrR3VpbGQoKSB7XG4gICAgY29uc3QgY2hhbm5lbHMgPSBuZXcgTWFwPHN0cmluZywgeyBpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IHR5cGU6IG51bWJlcjsgcGFyZW50SWQ6IHN0cmluZyB8IG51bGw7IGVkaXQ/OiBGdW5jdGlvbiB9PigpO1xuICAgIGxldCBjcmVhdGVDb3VudGVyID0gMDtcblxuICAgIGNvbnN0IG1vY2tHdWlsZCA9IHtcbiAgICAgIGlkOiAnZ3VpbGQtMTIzJywgLy8gQGV2ZXJ5b25lIHJvbGUgSUQgbWF0Y2hlcyBndWlsZCBJRFxuICAgICAgY2hhbm5lbHM6IHtcbiAgICAgICAgY2FjaGU6IHtcbiAgICAgICAgICBnZXQ6IChpZDogc3RyaW5nKSA9PiBjaGFubmVscy5nZXQoaWQpLFxuICAgICAgICAgIGZpbmQ6IChmbjogKGNoOiBhbnkpID0+IGJvb2xlYW4pID0+IHtcbiAgICAgICAgICAgIGZvciAoY29uc3QgY2ggb2YgY2hhbm5lbHMudmFsdWVzKCkpIHtcbiAgICAgICAgICAgICAgaWYgKGZuKGNoKSkgcmV0dXJuIGNoO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBjcmVhdGU6IGFzeW5jIChvcHRzOiB7IG5hbWU6IHN0cmluZzsgdHlwZTogbnVtYmVyOyBwYXJlbnQ/OiBzdHJpbmc7IHBlcm1pc3Npb25PdmVyd3JpdGVzPzogYW55W10gfSkgPT4ge1xuICAgICAgICAgIGNyZWF0ZUNvdW50ZXIrKztcbiAgICAgICAgICBjb25zdCBpZCA9IGBjaGFuLSR7Y3JlYXRlQ291bnRlcn1gO1xuICAgICAgICAgIGNvbnN0IGNoID0ge1xuICAgICAgICAgICAgaWQsXG4gICAgICAgICAgICBuYW1lOiBvcHRzLm5hbWUsXG4gICAgICAgICAgICB0eXBlOiBvcHRzLnR5cGUsXG4gICAgICAgICAgICBwYXJlbnRJZDogb3B0cy5wYXJlbnQgPz8gbnVsbCxcbiAgICAgICAgICAgIGVkaXQ6IGFzeW5jIChlZGl0T3B0czogYW55KSA9PiB7XG4gICAgICAgICAgICAgIC8vIFNpbXVsYXRlIGVkaXQgXHUyMDE0IHVwZGF0ZSBwYXJlbnRcbiAgICAgICAgICAgICAgY2gucGFyZW50SWQgPSBlZGl0T3B0cy5wYXJlbnQgPz8gY2gucGFyZW50SWQ7XG4gICAgICAgICAgICAgIHJldHVybiBjaDtcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfTtcbiAgICAgICAgICBjaGFubmVscy5zZXQoaWQsIGNoKTtcbiAgICAgICAgICByZXR1cm4gY2g7XG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgX2NoYW5uZWxzOiBjaGFubmVscywgLy8gaW50ZXJuYWwgZm9yIHRlc3QgaW5zcGVjdGlvblxuICAgICAgX2dldENyZWF0ZUNvdW50OiAoKSA9PiBjcmVhdGVDb3VudGVyLFxuICAgIH07XG5cbiAgICByZXR1cm4gbW9ja0d1aWxkO1xuICB9XG5cbiAgZnVuY3Rpb24gY3JlYXRlTW9ja0xvZ2dlcigpIHtcbiAgICBjb25zdCBlbnRyaWVzOiB7IGxldmVsOiBzdHJpbmc7IG1zZzogc3RyaW5nOyBkYXRhPzogYW55IH1bXSA9IFtdO1xuICAgIHJldHVybiB7XG4gICAgICBkZWJ1ZzogKG1zZzogc3RyaW5nLCBkYXRhPzogYW55KSA9PiBlbnRyaWVzLnB1c2goeyBsZXZlbDogJ2RlYnVnJywgbXNnLCBkYXRhIH0pLFxuICAgICAgaW5mbzogKG1zZzogc3RyaW5nLCBkYXRhPzogYW55KSA9PiBlbnRyaWVzLnB1c2goeyBsZXZlbDogJ2luZm8nLCBtc2csIGRhdGEgfSksXG4gICAgICB3YXJuOiAobXNnOiBzdHJpbmcsIGRhdGE/OiBhbnkpID0+IGVudHJpZXMucHVzaCh7IGxldmVsOiAnd2FybicsIG1zZywgZGF0YSB9KSxcbiAgICAgIGVycm9yOiAobXNnOiBzdHJpbmcsIGRhdGE/OiBhbnkpID0+IGVudHJpZXMucHVzaCh7IGxldmVsOiAnZXJyb3InLCBtc2csIGRhdGEgfSksXG4gICAgICBlbnRyaWVzLFxuICAgICAgY2xvc2U6IGFzeW5jICgpID0+IHt9LFxuICAgIH07XG4gIH1cblxuICBpdCgncmVzb2x2ZUNhdGVnb3J5IGNyZWF0ZXMgY2F0ZWdvcnkgd2hlbiBub3QgZm91bmQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgZ3VpbGQgPSBjcmVhdGVNb2NrR3VpbGQoKTtcbiAgICBjb25zdCBsb2dnZXIgPSBjcmVhdGVNb2NrTG9nZ2VyKCk7XG4gICAgY29uc3QgbWdyID0gbmV3IENoYW5uZWxNYW5hZ2VyKHsgZ3VpbGQ6IGd1aWxkIGFzIGFueSwgbG9nZ2VyOiBsb2dnZXIgYXMgYW55IH0pO1xuXG4gICAgY29uc3QgY2F0ID0gYXdhaXQgbWdyLnJlc29sdmVDYXRlZ29yeSgpO1xuICAgIGFzc2VydC5lcXVhbChjYXQubmFtZSwgJ0dTRCBQcm9qZWN0cycpO1xuICAgIGFzc2VydC5lcXVhbChjYXQudHlwZSwgQ2hhbm5lbFR5cGUuR3VpbGRDYXRlZ29yeSk7XG4gIH0pO1xuXG4gIGl0KCdyZXNvbHZlQ2F0ZWdvcnkgcmV0dXJucyBjYWNoZWQgY2F0ZWdvcnkgb24gc2Vjb25kIGNhbGwnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgZ3VpbGQgPSBjcmVhdGVNb2NrR3VpbGQoKTtcbiAgICBjb25zdCBsb2dnZXIgPSBjcmVhdGVNb2NrTG9nZ2VyKCk7XG4gICAgY29uc3QgbWdyID0gbmV3IENoYW5uZWxNYW5hZ2VyKHsgZ3VpbGQ6IGd1aWxkIGFzIGFueSwgbG9nZ2VyOiBsb2dnZXIgYXMgYW55IH0pO1xuXG4gICAgY29uc3QgY2F0MSA9IGF3YWl0IG1nci5yZXNvbHZlQ2F0ZWdvcnkoKTtcbiAgICBjb25zdCBjYXQyID0gYXdhaXQgbWdyLnJlc29sdmVDYXRlZ29yeSgpO1xuICAgIGFzc2VydC5lcXVhbChjYXQxLmlkLCBjYXQyLmlkKTtcbiAgICAvLyBPbmx5IG9uZSBjcmVhdGUgY2FsbCBzaG91bGQgaGF2ZSBiZWVuIG1hZGVcbiAgICBhc3NlcnQuZXF1YWwoZ3VpbGQuX2dldENyZWF0ZUNvdW50KCksIDEpO1xuICB9KTtcblxuICBpdCgncmVzb2x2ZUNhdGVnb3J5IGZpbmRzIGV4aXN0aW5nIGNhdGVnb3J5IGJ5IG5hbWUnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgZ3VpbGQgPSBjcmVhdGVNb2NrR3VpbGQoKTtcbiAgICAvLyBQcmUtcG9wdWxhdGUgYSBtYXRjaGluZyBjYXRlZ29yeVxuICAgIGd1aWxkLl9jaGFubmVscy5zZXQoJ2V4aXN0aW5nLWNhdCcsIHtcbiAgICAgIGlkOiAnZXhpc3RpbmctY2F0JyxcbiAgICAgIG5hbWU6ICdHU0QgUHJvamVjdHMnLFxuICAgICAgdHlwZTogQ2hhbm5lbFR5cGUuR3VpbGRDYXRlZ29yeSxcbiAgICAgIHBhcmVudElkOiBudWxsLFxuICAgIH0pO1xuXG4gICAgY29uc3QgbG9nZ2VyID0gY3JlYXRlTW9ja0xvZ2dlcigpO1xuICAgIGNvbnN0IG1nciA9IG5ldyBDaGFubmVsTWFuYWdlcih7IGd1aWxkOiBndWlsZCBhcyBhbnksIGxvZ2dlcjogbG9nZ2VyIGFzIGFueSB9KTtcblxuICAgIGNvbnN0IGNhdCA9IGF3YWl0IG1nci5yZXNvbHZlQ2F0ZWdvcnkoKTtcbiAgICBhc3NlcnQuZXF1YWwoY2F0LmlkLCAnZXhpc3RpbmctY2F0Jyk7XG4gICAgLy8gTm8gY3JlYXRlIGNhbGxzIFx1MjAxNCBmb3VuZCBleGlzdGluZ1xuICAgIGFzc2VydC5lcXVhbChndWlsZC5fZ2V0Q3JlYXRlQ291bnQoKSwgMCk7XG4gIH0pO1xuXG4gIGl0KCdjcmVhdGVQcm9qZWN0Q2hhbm5lbCBjcmVhdGVzIHRleHQgY2hhbm5lbCB1bmRlciBjYXRlZ29yeScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBndWlsZCA9IGNyZWF0ZU1vY2tHdWlsZCgpO1xuICAgIGNvbnN0IGxvZ2dlciA9IGNyZWF0ZU1vY2tMb2dnZXIoKTtcbiAgICBjb25zdCBtZ3IgPSBuZXcgQ2hhbm5lbE1hbmFnZXIoeyBndWlsZDogZ3VpbGQgYXMgYW55LCBsb2dnZXI6IGxvZ2dlciBhcyBhbnkgfSk7XG5cbiAgICBjb25zdCBjaGFubmVsID0gYXdhaXQgbWdyLmNyZWF0ZVByb2plY3RDaGFubmVsKCcvaG9tZS91c2VyL215LXByb2plY3QnKTtcbiAgICBhc3NlcnQuZXF1YWwoY2hhbm5lbC5uYW1lLCAnZ3NkLW15LXByb2plY3QnKTtcbiAgICBhc3NlcnQuZXF1YWwoY2hhbm5lbC50eXBlLCBDaGFubmVsVHlwZS5HdWlsZFRleHQpO1xuICAgIC8vIENhdGVnb3J5IHdhcyBjcmVhdGVkIGZpcnN0IChjaGFuLTEpLCB0aGVuIGNoYW5uZWwgKGNoYW4tMilcbiAgICBhc3NlcnQuZXF1YWwoY2hhbm5lbC5wYXJlbnRJZCwgJ2NoYW4tMScpO1xuICB9KTtcblxuICBpdCgnYXJjaGl2ZUNoYW5uZWwgbW92ZXMgY2hhbm5lbCB0byBhcmNoaXZlIGNhdGVnb3J5JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGd1aWxkID0gY3JlYXRlTW9ja0d1aWxkKCk7XG4gICAgY29uc3QgbG9nZ2VyID0gY3JlYXRlTW9ja0xvZ2dlcigpO1xuICAgIGNvbnN0IG1nciA9IG5ldyBDaGFubmVsTWFuYWdlcih7IGd1aWxkOiBndWlsZCBhcyBhbnksIGxvZ2dlcjogbG9nZ2VyIGFzIGFueSB9KTtcblxuICAgIC8vIENyZWF0ZSBhIHByb2plY3QgY2hhbm5lbCBmaXJzdFxuICAgIGNvbnN0IGNoYW5uZWwgPSBhd2FpdCBtZ3IuY3JlYXRlUHJvamVjdENoYW5uZWwoJy9ob21lL3VzZXIvcHJvamVjdCcpO1xuICAgIGNvbnN0IGNoYW5uZWxJZCA9IGNoYW5uZWwuaWQ7XG5cbiAgICAvLyBBcmNoaXZlIGl0XG4gICAgYXdhaXQgbWdyLmFyY2hpdmVDaGFubmVsKGNoYW5uZWxJZCk7XG5cbiAgICAvLyBUaGUgY2hhbm5lbCBzaG91bGQgaGF2ZSBiZWVuIGVkaXQoKS1lZCB3aXRoIHRoZSBhcmNoaXZlIGNhdGVnb3J5IGFzIHBhcmVudFxuICAgIGNvbnN0IGFyY2hpdmVkID0gZ3VpbGQuX2NoYW5uZWxzLmdldChjaGFubmVsSWQpITtcbiAgICAvLyBBcmNoaXZlIGNhdGVnb3J5IHdhcyBjcmVhdGVkIGFzIHRoZSAzcmQgY2hhbm5lbCAoY2hhbi0zKTogY2F0ZWdvcnkoY2hhbi0xKSwgdGV4dChjaGFuLTIpLCBhcmNoaXZlKGNoYW4tMylcbiAgICBhc3NlcnQuZXF1YWwoYXJjaGl2ZWQucGFyZW50SWQsICdjaGFuLTMnKTtcblxuICAgIC8vIFZlcmlmeSBhcmNoaXZlIGxvZ1xuICAgIGNvbnN0IGFyY2hpdmVMb2cgPSBsb2dnZXIuZW50cmllcy5maW5kKChlKSA9PiBlLm1zZyA9PT0gJ2NoYW5uZWwgYXJjaGl2ZWQnKTtcbiAgICBhc3NlcnQub2soYXJjaGl2ZUxvZywgJ3Nob3VsZCBsb2cgY2hhbm5lbCBhcmNoaXZlZCcpO1xuICAgIGFzc2VydC5lcXVhbChhcmNoaXZlTG9nIS5kYXRhLmNoYW5uZWxJZCwgY2hhbm5lbElkKTtcbiAgfSk7XG5cbiAgaXQoJ2FyY2hpdmVDaGFubmVsIHdhcm5zIHdoZW4gY2hhbm5lbCBub3QgZm91bmQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgZ3VpbGQgPSBjcmVhdGVNb2NrR3VpbGQoKTtcbiAgICBjb25zdCBsb2dnZXIgPSBjcmVhdGVNb2NrTG9nZ2VyKCk7XG4gICAgY29uc3QgbWdyID0gbmV3IENoYW5uZWxNYW5hZ2VyKHsgZ3VpbGQ6IGd1aWxkIGFzIGFueSwgbG9nZ2VyOiBsb2dnZXIgYXMgYW55IH0pO1xuXG4gICAgYXdhaXQgbWdyLmFyY2hpdmVDaGFubmVsKCdub25leGlzdGVudC1pZCcpO1xuICAgIGNvbnN0IHdhcm5Mb2cgPSBsb2dnZXIuZW50cmllcy5maW5kKChlKSA9PiBlLm1zZyA9PT0gJ2FyY2hpdmUgdGFyZ2V0IG5vdCBmb3VuZCcpO1xuICAgIGFzc2VydC5vayh3YXJuTG9nLCAnc2hvdWxkIHdhcm4gYWJvdXQgbWlzc2luZyBjaGFubmVsJyk7XG4gIH0pO1xuXG4gIGl0KCd1c2VzIGN1c3RvbSBjYXRlZ29yeSBuYW1lIHdoZW4gcHJvdmlkZWQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgZ3VpbGQgPSBjcmVhdGVNb2NrR3VpbGQoKTtcbiAgICBjb25zdCBsb2dnZXIgPSBjcmVhdGVNb2NrTG9nZ2VyKCk7XG4gICAgY29uc3QgbWdyID0gbmV3IENoYW5uZWxNYW5hZ2VyKHtcbiAgICAgIGd1aWxkOiBndWlsZCBhcyBhbnksXG4gICAgICBsb2dnZXI6IGxvZ2dlciBhcyBhbnksXG4gICAgICBjYXRlZ29yeU5hbWU6ICdDdXN0b20gQ2F0ZWdvcnknLFxuICAgIH0pO1xuXG4gICAgY29uc3QgY2F0ID0gYXdhaXQgbWdyLnJlc29sdmVDYXRlZ29yeSgpO1xuICAgIGFzc2VydC5lcXVhbChjYXQubmFtZSwgJ0N1c3RvbSBDYXRlZ29yeScpO1xuICB9KTtcbn0pO1xuXG4vLyAtLS0tLS0tLS0tIGJ1aWxkQ29tbWFuZHMgLS0tLS0tLS0tLVxuXG5kZXNjcmliZSgnYnVpbGRDb21tYW5kcycsICgpID0+IHtcbiAgaXQoJ3JldHVybnMgYXJyYXkgd2l0aCBjb3JyZWN0IGNvbW1hbmQgbmFtZXMnLCAoKSA9PiB7XG4gICAgY29uc3QgY29tbWFuZHMgPSBidWlsZENvbW1hbmRzKCk7XG4gICAgYXNzZXJ0LmVxdWFsKGNvbW1hbmRzLmxlbmd0aCwgNCk7XG4gICAgY29uc3QgbmFtZXMgPSBjb21tYW5kcy5tYXAoKGMpID0+IGMubmFtZSk7XG4gICAgYXNzZXJ0Lm9rKG5hbWVzLmluY2x1ZGVzKCdnc2Qtc3RhdHVzJyksICdzaG91bGQgaW5jbHVkZSBnc2Qtc3RhdHVzJyk7XG4gICAgYXNzZXJ0Lm9rKG5hbWVzLmluY2x1ZGVzKCdnc2Qtc3RhcnQnKSwgJ3Nob3VsZCBpbmNsdWRlIGdzZC1zdGFydCcpO1xuICAgIGFzc2VydC5vayhuYW1lcy5pbmNsdWRlcygnZ3NkLXN0b3AnKSwgJ3Nob3VsZCBpbmNsdWRlIGdzZC1zdG9wJyk7XG4gICAgYXNzZXJ0Lm9rKG5hbWVzLmluY2x1ZGVzKCdnc2QtdmVyYm9zZScpLCAnc2hvdWxkIGluY2x1ZGUgZ3NkLXZlcmJvc2UnKTtcbiAgfSk7XG5cbiAgaXQoJ2VhY2ggY29tbWFuZCBoYXMgYSBkZXNjcmlwdGlvbicsICgpID0+IHtcbiAgICBjb25zdCBjb21tYW5kcyA9IGJ1aWxkQ29tbWFuZHMoKTtcbiAgICBmb3IgKGNvbnN0IGNtZCBvZiBjb21tYW5kcykge1xuICAgICAgYXNzZXJ0Lm9rKGNtZC5kZXNjcmlwdGlvbiwgYGNvbW1hbmQgJHtjbWQubmFtZX0gc2hvdWxkIGhhdmUgYSBkZXNjcmlwdGlvbmApO1xuICAgICAgYXNzZXJ0Lm9rKGNtZC5kZXNjcmlwdGlvbi5sZW5ndGggPiAwLCBgY29tbWFuZCAke2NtZC5uYW1lfSBkZXNjcmlwdGlvbiBzaG91bGQgYmUgbm9uLWVtcHR5YCk7XG4gICAgfVxuICB9KTtcbn0pO1xuXG4vLyAtLS0tLS0tLS0tIGZvcm1hdFNlc3Npb25TdGF0dXMgLS0tLS0tLS0tLVxuXG5kZXNjcmliZSgnZm9ybWF0U2Vzc2lvblN0YXR1cycsICgpID0+IHtcbiAgZnVuY3Rpb24gbW9ja1Nlc3Npb24ob3ZlcnJpZGVzOiBQYXJ0aWFsPE1hbmFnZWRTZXNzaW9uPiA9IHt9KTogTWFuYWdlZFNlc3Npb24ge1xuICAgIHJldHVybiB7XG4gICAgICBzZXNzaW9uSWQ6ICdzZXNzLTEnLFxuICAgICAgcHJvamVjdERpcjogJy9ob21lL3VzZXIvcHJvamVjdCcsXG4gICAgICBwcm9qZWN0TmFtZTogJ3Byb2plY3QnLFxuICAgICAgc3RhdHVzOiAncnVubmluZycsXG4gICAgICBjbGllbnQ6IHt9IGFzIGFueSxcbiAgICAgIGV2ZW50czogW10sXG4gICAgICBwZW5kaW5nQmxvY2tlcjogbnVsbCxcbiAgICAgIGNvc3Q6IHsgdG90YWxDb3N0OiAwLjEyMzQsIHRva2VuczogeyBpbnB1dDogMTAwLCBvdXRwdXQ6IDUwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAgfSB9LFxuICAgICAgc3RhcnRUaW1lOiBEYXRlLm5vdygpIC0gMTIwXzAwMCwgLy8gMiBtaW51dGVzIGFnb1xuICAgICAgLi4ub3ZlcnJpZGVzLFxuICAgIH07XG4gIH1cblxuICBpdCgncmV0dXJucyBcIk5vIGFjdGl2ZSBzZXNzaW9ucy5cIiBmb3IgZW1wdHkgYXJyYXknLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKGZvcm1hdFNlc3Npb25TdGF0dXMoW10pLCAnTm8gYWN0aXZlIHNlc3Npb25zLicpO1xuICB9KTtcblxuICBpdCgnZm9ybWF0cyBzaW5nbGUgc2Vzc2lvbiB3aXRoIHByb2plY3QgbmFtZSBhbmQgc3RhdHVzJywgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGZvcm1hdFNlc3Npb25TdGF0dXMoW21vY2tTZXNzaW9uKCldKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKCdwcm9qZWN0JyksICdzaG91bGQgY29udGFpbiBwcm9qZWN0IG5hbWUnKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKCdydW5uaW5nJyksICdzaG91bGQgY29udGFpbiBzdGF0dXMnKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKCckJyksICdzaG91bGQgY29udGFpbiBjb3N0Jyk7XG4gIH0pO1xuXG4gIGl0KCdmb3JtYXRzIG11bHRpcGxlIHNlc3Npb25zIG9uIHNlcGFyYXRlIGxpbmVzJywgKCkgPT4ge1xuICAgIGNvbnN0IHNlc3Npb25zID0gW1xuICAgICAgbW9ja1Nlc3Npb24oeyBwcm9qZWN0TmFtZTogJ2FscGhhJywgc3RhdHVzOiAncnVubmluZycgfSksXG4gICAgICBtb2NrU2Vzc2lvbih7IHByb2plY3ROYW1lOiAnYmV0YScsIHN0YXR1czogJ2Jsb2NrZWQnIH0pLFxuICAgIF07XG4gICAgY29uc3QgcmVzdWx0ID0gZm9ybWF0U2Vzc2lvblN0YXR1cyhzZXNzaW9ucyk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcygnYWxwaGEnKSwgJ3Nob3VsZCBjb250YWluIGZpcnN0IHByb2plY3QnKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKCdiZXRhJyksICdzaG91bGQgY29udGFpbiBzZWNvbmQgcHJvamVjdCcpO1xuICAgIGNvbnN0IGxpbmVzID0gcmVzdWx0LnNwbGl0KCdcXG4nKTtcbiAgICBhc3NlcnQuZXF1YWwobGluZXMubGVuZ3RoLCAyLCAnc2hvdWxkIGhhdmUgb25lIGxpbmUgcGVyIHNlc3Npb24nKTtcbiAgfSk7XG5cbiAgaXQoJ2Zvcm1hdHMgNSBzZXNzaW9ucyBjb3JyZWN0bHknLCAoKSA9PiB7XG4gICAgY29uc3Qgc2Vzc2lvbnMgPSBBcnJheS5mcm9tKHsgbGVuZ3RoOiA1IH0sIChfLCBpKSA9PlxuICAgICAgbW9ja1Nlc3Npb24oeyBwcm9qZWN0TmFtZTogYHByb2otJHtpfWAsIHN0YXR1czogaSAlIDIgPT09IDAgPyAncnVubmluZycgOiAnY29tcGxldGVkJyB9KSxcbiAgICApO1xuICAgIGNvbnN0IHJlc3VsdCA9IGZvcm1hdFNlc3Npb25TdGF0dXMoc2Vzc2lvbnMpO1xuICAgIGNvbnN0IGxpbmVzID0gcmVzdWx0LnNwbGl0KCdcXG4nKTtcbiAgICBhc3NlcnQuZXF1YWwobGluZXMubGVuZ3RoLCA1KTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDU7IGkrKykge1xuICAgICAgYXNzZXJ0Lm9rKGxpbmVzW2ldLmluY2x1ZGVzKGBwcm9qLSR7aX1gKSk7XG4gICAgfVxuICB9KTtcbn0pO1xuXG4vLyAtLS0tLS0tLS0tIENvbW1hbmQgZGlzcGF0Y2ggKG1vY2sgaW50ZXJhY3Rpb24pIC0tLS0tLS0tLS1cblxuZGVzY3JpYmUoJ2NvbW1hbmQgZGlzcGF0Y2gnLCAoKSA9PiB7XG4gIC8vIE1pbmltYWwgbW9jayBvZiBhIENoYXRJbnB1dENvbW1hbmRJbnRlcmFjdGlvblxuICBmdW5jdGlvbiBtb2NrSW50ZXJhY3Rpb24oY29tbWFuZE5hbWU6IHN0cmluZywgdXNlcklkOiBzdHJpbmcgPSAnb3duZXItMScpIHtcbiAgICBsZXQgcmVwbGllZCA9IGZhbHNlO1xuICAgIGxldCByZXBseUNvbnRlbnQgPSAnJztcblxuICAgIHJldHVybiB7XG4gICAgICB1c2VyOiB7IGlkOiB1c2VySWQgfSxcbiAgICAgIHR5cGU6IDIsIC8vIEludGVyYWN0aW9uVHlwZS5BcHBsaWNhdGlvbkNvbW1hbmRcbiAgICAgIGlzQ2hhdElucHV0Q29tbWFuZDogKCkgPT4gdHJ1ZSxcbiAgICAgIGNvbW1hbmROYW1lLFxuICAgICAgcmVwbHk6IGFzeW5jIChvcHRzOiB7IGNvbnRlbnQ6IHN0cmluZzsgZXBoZW1lcmFsPzogYm9vbGVhbiB9KSA9PiB7XG4gICAgICAgIHJlcGxpZWQgPSB0cnVlO1xuICAgICAgICByZXBseUNvbnRlbnQgPSBvcHRzLmNvbnRlbnQ7XG4gICAgICB9LFxuICAgICAgX2dldFJlcGxpZWQ6ICgpID0+IHJlcGxpZWQsXG4gICAgICBfZ2V0UmVwbHlDb250ZW50OiAoKSA9PiByZXBseUNvbnRlbnQsXG4gICAgfTtcbiAgfVxuXG4gIC8vIE1pbmltYWwgbW9jayBvZiBhIG5vbi1jb21tYW5kIGludGVyYWN0aW9uXG4gIGZ1bmN0aW9uIG1vY2tOb25Db21tYW5kSW50ZXJhY3Rpb24odXNlcklkOiBzdHJpbmcgPSAnb3duZXItMScpIHtcbiAgICBsZXQgcmVwbGllZCA9IGZhbHNlO1xuICAgIHJldHVybiB7XG4gICAgICB1c2VyOiB7IGlkOiB1c2VySWQgfSxcbiAgICAgIHR5cGU6IDMsIC8vIEludGVyYWN0aW9uVHlwZS5NZXNzYWdlQ29tcG9uZW50XG4gICAgICBpc0NoYXRJbnB1dENvbW1hbmQ6ICgpID0+IGZhbHNlLFxuICAgICAgX2dldFJlcGxpZWQ6ICgpID0+IHJlcGxpZWQsXG4gICAgfTtcbiAgfVxuXG4gIC8vIFdlIGNhbid0IGVhc2lseSB0ZXN0IHRocm91Z2ggRGlzY29yZEJvdC5oYW5kbGVJbnRlcmFjdGlvbiBzaW5jZSBpdCdzIHByaXZhdGUuXG4gIC8vIEluc3RlYWQsIHRlc3QgdGhlIHB1cmUgZnVuY3Rpb25zIHRoYXQgdGhlIGhhbmRsZXIgY2FsbHMsIGFuZCB0ZXN0IGF1dGggZ3VhcmRcbiAgLy8gYmVoYXZpb3IgdmlhIHRoZSBtb2NrIGludGVyYWN0aW9uIGZsb3cuXG4gIC8vIFRoZSBjb21tYW5kIHJvdXRpbmcgbG9naWMgaXMgdGVzdGVkIGluZGlyZWN0bHkgdGhyb3VnaCBpbnRlZ3JhdGlvbiBvZiB0aGVcbiAgLy8gcHVyZSBoZWxwZXJzIChidWlsZENvbW1hbmRzLCBmb3JtYXRTZXNzaW9uU3RhdHVzLCBpc0F1dGhvcml6ZWQpLlxuXG4gIGl0KCdnc2Qtc3RhdHVzIHdpdGggbm8gc2Vzc2lvbnMgcHJvZHVjZXMgZW1wdHkgbWVzc2FnZScsICgpID0+IHtcbiAgICAvLyBUZXN0cyB0aGUgZm9ybWF0U2Vzc2lvblN0YXR1cyBwYXRoIHRoYXQgL2dzZC1zdGF0dXMgY2FsbHNcbiAgICBjb25zdCByZXN1bHQgPSBmb3JtYXRTZXNzaW9uU3RhdHVzKFtdKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCAnTm8gYWN0aXZlIHNlc3Npb25zLicpO1xuICB9KTtcblxuICBpdCgndW5rbm93biBjb21tYW5kIG5hbWUgaXMgbm90IGluIGJ1aWxkQ29tbWFuZHMgbGlzdCcsICgpID0+IHtcbiAgICBjb25zdCBjb21tYW5kcyA9IGJ1aWxkQ29tbWFuZHMoKTtcbiAgICBjb25zdCBuYW1lcyA9IGNvbW1hbmRzLm1hcCgoYykgPT4gYy5uYW1lKTtcbiAgICBhc3NlcnQub2soIW5hbWVzLmluY2x1ZGVzKCdnc2QtdW5rbm93bicpLCAndW5rbm93biBzaG91bGQgbm90IGJlIGluIGNvbW1hbmQgbGlzdCcpO1xuICB9KTtcblxuICBpdCgnYXV0aCBndWFyZCByZWplY3RzIG5vbi1vd25lciBvbiBpbnRlcmFjdGlvbicsICgpID0+IHtcbiAgICAvLyBTaW11bGF0ZXMgdGhlIGZpcnN0IGNoZWNrIGluIGhhbmRsZUludGVyYWN0aW9uXG4gICAgY29uc3QgYXV0aG9yaXplZCA9IGlzQXV0aG9yaXplZCgnaW50cnVkZXItOTk5JywgJ293bmVyLTEnKTtcbiAgICBhc3NlcnQuZXF1YWwoYXV0aG9yaXplZCwgZmFsc2UpO1xuICB9KTtcblxuICBpdCgnYXV0aCBndWFyZCBhY2NlcHRzIG93bmVyIG9uIGludGVyYWN0aW9uJywgKCkgPT4ge1xuICAgIGNvbnN0IGF1dGhvcml6ZWQgPSBpc0F1dGhvcml6ZWQoJ293bmVyLTEnLCAnb3duZXItMScpO1xuICAgIGFzc2VydC5lcXVhbChhdXRob3JpemVkLCB0cnVlKTtcbiAgfSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLSBDb25maWcgdmFsaWRhdGlvbjogbmV3IGZpZWxkcyAtLS0tLS0tLS0tXG5cbmRlc2NyaWJlKCd2YWxpZGF0ZUNvbmZpZyBcdTIwMTQgY29udHJvbF9jaGFubmVsX2lkIGFuZCBvcmNoZXN0cmF0b3InLCAoKSA9PiB7XG4gIGl0KCdwYXJzZXMgY29udHJvbF9jaGFubmVsX2lkIGZyb20gZGlzY29yZCBibG9jaycsICgpID0+IHtcbiAgICBjb25zdCBjb25maWcgPSB2YWxpZGF0ZUNvbmZpZyh7XG4gICAgICBkaXNjb3JkOiB7XG4gICAgICAgIHRva2VuOiAndG9rJyxcbiAgICAgICAgZ3VpbGRfaWQ6ICdnMScsXG4gICAgICAgIG93bmVyX2lkOiAnbzEnLFxuICAgICAgICBjb250cm9sX2NoYW5uZWxfaWQ6ICdjaC0xMjMnLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBhc3NlcnQuZXF1YWwoY29uZmlnLmRpc2NvcmQ/LmNvbnRyb2xfY2hhbm5lbF9pZCwgJ2NoLTEyMycpO1xuICB9KTtcblxuICBpdCgnb21pdHMgY29udHJvbF9jaGFubmVsX2lkIHdoZW4gbm90IHByZXNlbnQnLCAoKSA9PiB7XG4gICAgY29uc3QgY29uZmlnID0gdmFsaWRhdGVDb25maWcoe1xuICAgICAgZGlzY29yZDoge1xuICAgICAgICB0b2tlbjogJ3RvaycsXG4gICAgICAgIGd1aWxkX2lkOiAnZzEnLFxuICAgICAgICBvd25lcl9pZDogJ28xJyxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKGNvbmZpZy5kaXNjb3JkPy5jb250cm9sX2NoYW5uZWxfaWQsIHVuZGVmaW5lZCk7XG4gIH0pO1xuXG4gIGl0KCdwYXJzZXMgb3JjaGVzdHJhdG9yIG1vZGVsIGFuZCBtYXhfdG9rZW5zJywgKCkgPT4ge1xuICAgIGNvbnN0IGNvbmZpZyA9IHZhbGlkYXRlQ29uZmlnKHtcbiAgICAgIGRpc2NvcmQ6IHtcbiAgICAgICAgdG9rZW46ICd0b2snLFxuICAgICAgICBndWlsZF9pZDogJ2cxJyxcbiAgICAgICAgb3duZXJfaWQ6ICdvMScsXG4gICAgICAgIG9yY2hlc3RyYXRvcjogeyBtb2RlbDogJ2NsYXVkZS1vcHVzLTIwMjUnLCBtYXhfdG9rZW5zOiAyMDQ4IH0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGFzc2VydC5lcXVhbChjb25maWcuZGlzY29yZD8ub3JjaGVzdHJhdG9yPy5tb2RlbCwgJ2NsYXVkZS1vcHVzLTIwMjUnKTtcbiAgICBhc3NlcnQuZXF1YWwoY29uZmlnLmRpc2NvcmQ/Lm9yY2hlc3RyYXRvcj8ubWF4X3Rva2VucywgMjA0OCk7XG4gIH0pO1xuXG4gIGl0KCdtaXNzaW5nIG9yY2hlc3RyYXRvciBibG9jayByZXN1bHRzIGluIHVuZGVmaW5lZCcsICgpID0+IHtcbiAgICBjb25zdCBjb25maWcgPSB2YWxpZGF0ZUNvbmZpZyh7XG4gICAgICBkaXNjb3JkOiB7XG4gICAgICAgIHRva2VuOiAndG9rJyxcbiAgICAgICAgZ3VpbGRfaWQ6ICdnMScsXG4gICAgICAgIG93bmVyX2lkOiAnbzEnLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBhc3NlcnQuZXF1YWwoY29uZmlnLmRpc2NvcmQ/Lm9yY2hlc3RyYXRvciwgdW5kZWZpbmVkKTtcbiAgfSk7XG5cbiAgaXQoJ2VtcHR5IG9yY2hlc3RyYXRvciBibG9jayBoYXMgbm8gbW9kZWwgb3IgbWF4X3Rva2VucycsICgpID0+IHtcbiAgICBjb25zdCBjb25maWcgPSB2YWxpZGF0ZUNvbmZpZyh7XG4gICAgICBkaXNjb3JkOiB7XG4gICAgICAgIHRva2VuOiAndG9rJyxcbiAgICAgICAgZ3VpbGRfaWQ6ICdnMScsXG4gICAgICAgIG93bmVyX2lkOiAnbzEnLFxuICAgICAgICBvcmNoZXN0cmF0b3I6IHt9LFxuICAgICAgfSxcbiAgICB9KTtcbiAgICAvLyBvcmNoZXN0cmF0b3Igb2JqZWN0IHNob3VsZCBleGlzdCBidXQgd2l0aCBubyB2YWx1ZXMgc2V0XG4gICAgYXNzZXJ0Lm9rKGNvbmZpZy5kaXNjb3JkPy5vcmNoZXN0cmF0b3IgIT09IHVuZGVmaW5lZCk7XG4gICAgYXNzZXJ0LmVxdWFsKGNvbmZpZy5kaXNjb3JkPy5vcmNoZXN0cmF0b3I/Lm1vZGVsLCB1bmRlZmluZWQpO1xuICAgIGFzc2VydC5lcXVhbChjb25maWcuZGlzY29yZD8ub3JjaGVzdHJhdG9yPy5tYXhfdG9rZW5zLCB1bmRlZmluZWQpO1xuICB9KTtcblxuICBpdCgnaWdub3JlcyBub24tbnVtZXJpYyBtYXhfdG9rZW5zJywgKCkgPT4ge1xuICAgIGNvbnN0IGNvbmZpZyA9IHZhbGlkYXRlQ29uZmlnKHtcbiAgICAgIGRpc2NvcmQ6IHtcbiAgICAgICAgdG9rZW46ICd0b2snLFxuICAgICAgICBndWlsZF9pZDogJ2cxJyxcbiAgICAgICAgb3duZXJfaWQ6ICdvMScsXG4gICAgICAgIG9yY2hlc3RyYXRvcjogeyBtYXhfdG9rZW5zOiAnbm90IGEgbnVtYmVyJyB9LFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBhc3NlcnQuZXF1YWwoY29uZmlnLmRpc2NvcmQ/Lm9yY2hlc3RyYXRvcj8ubWF4X3Rva2VucywgdW5kZWZpbmVkKTtcbiAgfSk7XG5cbiAgaXQoJ2lnbm9yZXMgbm9uLXN0cmluZyBtb2RlbCcsICgpID0+IHtcbiAgICBjb25zdCBjb25maWcgPSB2YWxpZGF0ZUNvbmZpZyh7XG4gICAgICBkaXNjb3JkOiB7XG4gICAgICAgIHRva2VuOiAndG9rJyxcbiAgICAgICAgZ3VpbGRfaWQ6ICdnMScsXG4gICAgICAgIG93bmVyX2lkOiAnbzEnLFxuICAgICAgICBvcmNoZXN0cmF0b3I6IHsgbW9kZWw6IDQyIH0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGFzc2VydC5lcXVhbChjb25maWcuZGlzY29yZD8ub3JjaGVzdHJhdG9yPy5tb2RlbCwgdW5kZWZpbmVkKTtcbiAgfSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLSBEYWVtb24gd2lyaW5nOiBvcmNoZXN0cmF0b3IgLS0tLS0tLS0tLVxuXG5kZXNjcmliZSgnRGFlbW9uIG9yY2hlc3RyYXRvciB3aXJpbmcnLCAoKSA9PiB7XG4gIGl0KCdvcmNoZXN0cmF0b3IgaXMgdW5kZWZpbmVkIHdoZW4gY29udHJvbF9jaGFubmVsX2lkIGlzIG5vdCBzZXQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgZGlyID0gdG1wRGlyKCk7XG4gICAgY2xlYW51cERpcnMucHVzaChkaXIpO1xuICAgIGNvbnN0IGxvZ1BhdGggPSBqb2luKGRpciwgJ25vLW9yY2hlc3RyYXRvci5sb2cnKTtcblxuICAgIGNvbnN0IGNvbmZpZzogRGFlbW9uQ29uZmlnID0ge1xuICAgICAgZGlzY29yZDogdW5kZWZpbmVkLFxuICAgICAgcHJvamVjdHM6IHsgc2Nhbl9yb290czogW10gfSxcbiAgICAgIGxvZzogeyBmaWxlOiBsb2dQYXRoLCBsZXZlbDogJ2RlYnVnJywgbWF4X3NpemVfbWI6IDUwIH0sXG4gICAgfTtcblxuICAgIGNvbnN0IGxvZ2dlciA9IG5ldyBMb2dnZXIoeyBmaWxlUGF0aDogbG9nUGF0aCwgbGV2ZWw6ICdkZWJ1ZycgfSk7XG4gICAgY29uc3QgZGFlbW9uID0gbmV3IERhZW1vbihjb25maWcsIGxvZ2dlcik7XG5cbiAgICBhd2FpdCBkYWVtb24uc3RhcnQoKTtcbiAgICBhc3NlcnQuZXF1YWwoZGFlbW9uLmdldE9yY2hlc3RyYXRvcigpLCB1bmRlZmluZWQpO1xuXG4gICAgY29uc3Qgb3JpZ0V4aXQgPSBwcm9jZXNzLmV4aXQ7XG4gICAgLy8gQHRzLWV4cGVjdC1lcnJvciBcdTIwMTQgb3ZlcnJpZGluZyBwcm9jZXNzLmV4aXQgZm9yIHRlc3RcbiAgICBwcm9jZXNzLmV4aXQgPSAoKSA9PiB7fTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgZGFlbW9uLnNodXRkb3duKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHByb2Nlc3MuZXhpdCA9IG9yaWdFeGl0O1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoJ29yY2hlc3RyYXRvciBpcyB1bmRlZmluZWQgd2hlbiBkaXNjb3JkIGhhcyBubyBjb250cm9sX2NoYW5uZWxfaWQnLCBhc3luYyAoKSA9PiB7XG4gICAgLy8gRXZlbiB3aXRoIGEgZGlzY29yZCBibG9jayB0aGF0IGZhaWxzIGxvZ2luLCBvcmNoZXN0cmF0b3Igc2hvdWxkIG5vdCBiZSBjcmVhdGVkXG4gICAgLy8gYmVjYXVzZSB0aGVyZSdzIG5vIGNvbnRyb2xfY2hhbm5lbF9pZFxuICAgIGNvbnN0IGRpciA9IHRtcERpcigpO1xuICAgIGNsZWFudXBEaXJzLnB1c2goZGlyKTtcbiAgICBjb25zdCBsb2dQYXRoID0gam9pbihkaXIsICduby1jdGwtY2hhbi5sb2cnKTtcblxuICAgIGNvbnN0IGNvbmZpZzogRGFlbW9uQ29uZmlnID0ge1xuICAgICAgZGlzY29yZDoge1xuICAgICAgICB0b2tlbjogJ2JhZC10b2tlbicsXG4gICAgICAgIGd1aWxkX2lkOiAnZzEnLFxuICAgICAgICBvd25lcl9pZDogJ28xJyxcbiAgICAgICAgLy8gY29udHJvbF9jaGFubmVsX2lkIGludGVudGlvbmFsbHkgb21pdHRlZFxuICAgICAgfSxcbiAgICAgIHByb2plY3RzOiB7IHNjYW5fcm9vdHM6IFtdIH0sXG4gICAgICBsb2c6IHsgZmlsZTogbG9nUGF0aCwgbGV2ZWw6ICdkZWJ1ZycsIG1heF9zaXplX21iOiA1MCB9LFxuICAgIH07XG5cbiAgICBjb25zdCBsb2dnZXIgPSBuZXcgTG9nZ2VyKHsgZmlsZVBhdGg6IGxvZ1BhdGgsIGxldmVsOiAnZGVidWcnIH0pO1xuICAgIGNvbnN0IGRhZW1vbiA9IG5ldyBEYWVtb24oY29uZmlnLCBsb2dnZXIpO1xuXG4gICAgYXdhaXQgZGFlbW9uLnN0YXJ0KCk7XG4gICAgLy8gTG9naW4gZmFpbHMsIHNvIG9yY2hlc3RyYXRvciBjYW4ndCBiZSB3aXJlZCByZWdhcmRsZXNzLiBCdXQgdGhlIGNvZGUgcGF0aFxuICAgIC8vIHRoYXQgY2hlY2tzIGNvbnRyb2xfY2hhbm5lbF9pZCBjb21lcyBhZnRlciBzdWNjZXNzZnVsIGxvZ2luL2V2ZW50QnJpZGdlIHdpcmluZy5cbiAgICAvLyBTaW5jZSBsb2dpbiBmYWlscywgb3JjaGVzdHJhdG9yIGlzIHVuZGVmaW5lZC5cbiAgICBhc3NlcnQuZXF1YWwoZGFlbW9uLmdldE9yY2hlc3RyYXRvcigpLCB1bmRlZmluZWQpO1xuXG4gICAgY29uc3Qgb3JpZ0V4aXQgPSBwcm9jZXNzLmV4aXQ7XG4gICAgLy8gQHRzLWV4cGVjdC1lcnJvciBcdTIwMTQgb3ZlcnJpZGluZyBwcm9jZXNzLmV4aXQgZm9yIHRlc3RcbiAgICBwcm9jZXNzLmV4aXQgPSAoKSA9PiB7fTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgZGFlbW9uLnNodXRkb3duKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHByb2Nlc3MuZXhpdCA9IG9yaWdFeGl0O1xuICAgIH1cbiAgfSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLSAvZ3NkLXN0YXJ0IGFuZCAvZ3NkLXN0b3AgbG9naWMgcGF0aHMgLS0tLS0tLS0tLVxuXG5kZXNjcmliZSgnL2dzZC1zdGFydCBhbmQgL2dzZC1zdG9wIGxvZ2ljJywgKCkgPT4ge1xuICAvLyBUaGVzZSB0ZXN0IHRoZSBvYnNlcnZhYmxlIGxvZ2ljIHBhdGhzIGV4ZXJjaXNlZCBieSB0aGUgaGFuZGxlcnMuXG4gIC8vIFNpbmNlIGhhbmRsZUdzZFN0YXJ0L2hhbmRsZUdzZFN0b3AgYXJlIHByaXZhdGUsIHdlIHRlc3QgdGhlIGRhdGEgbGF5ZXJcbiAgLy8gdGhleSBkZXBlbmQgb24gXHUyMDE0IHByb2plY3Qgc2Nhbm5pbmcsIHNlc3Npb24gbGlzdGluZywgYW5kIGVkZ2UgY2FzZXMuXG5cbiAgaXQoJy9nc2Qtc3RhcnQ6IHNjYW5Gb3JQcm9qZWN0cyByZXR1cm5pbmcgMCBwcm9qZWN0cycsIGFzeW5jICgpID0+IHtcbiAgICAvLyBTaW11bGF0ZXMgdGhlIFwibm8gcHJvamVjdHNcIiBwYXRoXG4gICAgY29uc3QgeyBzY2FuRm9yUHJvamVjdHMgfSA9IGF3YWl0IGltcG9ydCgnLi9wcm9qZWN0LXNjYW5uZXIuanMnKTtcbiAgICAvLyBXaXRoIG5vIHNjYW4gcm9vdHMsIHNob3VsZCByZXR1cm4gZW1wdHlcbiAgICBjb25zdCBwcm9qZWN0cyA9IGF3YWl0IHNjYW5Gb3JQcm9qZWN0cyhbXSk7XG4gICAgYXNzZXJ0LmVxdWFsKHByb2plY3RzLmxlbmd0aCwgMCk7XG4gIH0pO1xuXG4gIGl0KCcvZ3NkLXN0b3A6IGdldEFsbFNlc3Npb25zIHJldHVybnMgZW1wdHkgd2hlbiBubyBzZXNzaW9ucyBhY3RpdmUnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBTZXNzaW9uTWFuYWdlciB9ID0gYXdhaXQgaW1wb3J0KCcuL3Nlc3Npb24tbWFuYWdlci5qcycpO1xuICAgIGNvbnN0IGRpciA9IHRtcERpcigpO1xuICAgIGNsZWFudXBEaXJzLnB1c2goZGlyKTtcbiAgICBjb25zdCBsb2dQYXRoID0gam9pbihkaXIsICdzbS10ZXN0LmxvZycpO1xuICAgIGNvbnN0IGxvZ2dlciA9IG5ldyBMb2dnZXIoeyBmaWxlUGF0aDogbG9nUGF0aCwgbGV2ZWw6ICdkZWJ1ZycgfSk7XG4gICAgY29uc3Qgc20gPSBuZXcgU2Vzc2lvbk1hbmFnZXIobG9nZ2VyKTtcbiAgICBjb25zdCBzZXNzaW9ucyA9IHNtLmdldEFsbFNlc3Npb25zKCk7XG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb25zLmxlbmd0aCwgMCk7XG4gICAgYXdhaXQgbG9nZ2VyLmNsb3NlKCk7XG4gIH0pO1xuXG4gIGl0KCcvZ3NkLXN0b3A6IGZpbHRlcnMgdG8gYWN0aXZlIHNlc3Npb25zIG9ubHknLCAoKSA9PiB7XG4gICAgLy8gU2ltdWxhdGUgdGhlIGZpbHRlciBsb2dpYyB1c2VkIGluIGhhbmRsZUdzZFN0b3BcbiAgICBjb25zdCBhbGxTZXNzaW9uczogUGFydGlhbDxNYW5hZ2VkU2Vzc2lvbj5bXSA9IFtcbiAgICAgIHsgc2Vzc2lvbklkOiAnczEnLCBzdGF0dXM6ICdydW5uaW5nJywgcHJvamVjdE5hbWU6ICdhbHBoYScgfSxcbiAgICAgIHsgc2Vzc2lvbklkOiAnczInLCBzdGF0dXM6ICdjb21wbGV0ZWQnLCBwcm9qZWN0TmFtZTogJ2JldGEnIH0sXG4gICAgICB7IHNlc3Npb25JZDogJ3MzJywgc3RhdHVzOiAnYmxvY2tlZCcsIHByb2plY3ROYW1lOiAnZ2FtbWEnIH0sXG4gICAgICB7IHNlc3Npb25JZDogJ3M0Jywgc3RhdHVzOiAnZXJyb3InLCBwcm9qZWN0TmFtZTogJ2RlbHRhJyB9LFxuICAgICAgeyBzZXNzaW9uSWQ6ICdzNScsIHN0YXR1czogJ3N0YXJ0aW5nJywgcHJvamVjdE5hbWU6ICdlcHNpbG9uJyB9LFxuICAgICAgeyBzZXNzaW9uSWQ6ICdzNicsIHN0YXR1czogJ2NhbmNlbGxlZCcsIHByb2plY3ROYW1lOiAnemV0YScgfSxcbiAgICBdO1xuICAgIGNvbnN0IGFjdGl2ZSA9IGFsbFNlc3Npb25zLmZpbHRlcihcbiAgICAgIChzKSA9PiBzLnN0YXR1cyA9PT0gJ3J1bm5pbmcnIHx8IHMuc3RhdHVzID09PSAnYmxvY2tlZCcgfHwgcy5zdGF0dXMgPT09ICdzdGFydGluZycsXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwoYWN0aXZlLmxlbmd0aCwgMyk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChhY3RpdmUubWFwKChzKSA9PiBzLnByb2plY3ROYW1lKSwgWydhbHBoYScsICdnYW1tYScsICdlcHNpbG9uJ10pO1xuICB9KTtcblxuICBpdCgnL2dzZC1zdGFydDogPjI1IHByb2plY3RzIGFyZSB0cnVuY2F0ZWQgZm9yIHNlbGVjdCBtZW51JywgKCkgPT4ge1xuICAgIC8vIFNpbXVsYXRlIHRoZSB0cnVuY2F0aW9uIGxvZ2ljXG4gICAgY29uc3QgcHJvamVjdHMgPSBBcnJheS5mcm9tKHsgbGVuZ3RoOiAzMCB9LCAoXywgaSkgPT4gKHtcbiAgICAgIG5hbWU6IGBwcm9qZWN0LSR7aX1gLFxuICAgICAgcGF0aDogYC9ob21lL3VzZXIvcHJvamVjdC0ke2l9YCxcbiAgICAgIG1hcmtlcnM6IFtdIGFzIHN0cmluZ1tdLFxuICAgICAgbGFzdE1vZGlmaWVkOiBEYXRlLm5vdygpLFxuICAgIH0pKTtcbiAgICBjb25zdCB0cnVuY2F0ZWQgPSBwcm9qZWN0cy5zbGljZSgwLCAyNSk7XG4gICAgYXNzZXJ0LmVxdWFsKHRydW5jYXRlZC5sZW5ndGgsIDI1KTtcbiAgICBhc3NlcnQuZXF1YWwodHJ1bmNhdGVkWzI0XS5uYW1lLCAncHJvamVjdC0yNCcpO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLElBQUksaUJBQWlCO0FBQ3hDLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsY0FBYyxRQUFRLGtCQUFrQjtBQUM5RCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsbUJBQW1CO0FBQzVCLFNBQVMsY0FBYyw2QkFBNkI7QUFDcEQsU0FBUyxxQkFBcUIsc0JBQXNCO0FBQ3BELFNBQVMsZUFBZSwyQkFBMkI7QUFDbkQsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsY0FBYztBQUN2QixTQUFTLHNCQUFzQjtBQUsvQixTQUFTLFNBQWlCO0FBQ3hCLFNBQU8sWUFBWSxLQUFLLE9BQU8sR0FBRyxnQkFBZ0IsV0FBVyxFQUFFLE1BQU0sR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDO0FBQ2hGO0FBRUEsTUFBTSxjQUF3QixDQUFDO0FBQy9CLFVBQVUsTUFBTTtBQUNkLFNBQU8sWUFBWSxRQUFRO0FBQ3pCLFVBQU0sSUFBSSxZQUFZLElBQUk7QUFDMUIsUUFBSSxXQUFXLENBQUMsRUFBRyxRQUFPLEdBQUcsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUMvRDtBQUNGLENBQUM7QUFJRCxTQUFTLGdCQUFnQixNQUFNO0FBQzdCLEtBQUcsNENBQTRDLE1BQU07QUFDbkQsV0FBTyxNQUFNLGFBQWEsU0FBUyxPQUFPLEdBQUcsSUFBSTtBQUFBLEVBQ25ELENBQUM7QUFFRCxLQUFHLG9EQUFvRCxNQUFNO0FBQzNELFdBQU8sTUFBTSxhQUFhLFNBQVMsT0FBTyxHQUFHLEtBQUs7QUFBQSxFQUNwRCxDQUFDO0FBRUQsS0FBRyx1Q0FBdUMsTUFBTTtBQUM5QyxXQUFPLE1BQU0sYUFBYSxTQUFTLEVBQUUsR0FBRyxLQUFLO0FBQUEsRUFDL0MsQ0FBQztBQUVELEtBQUcsc0NBQXNDLE1BQU07QUFDN0MsV0FBTyxNQUFNLGFBQWEsSUFBSSxPQUFPLEdBQUcsS0FBSztBQUFBLEVBQy9DLENBQUM7QUFFRCxLQUFHLHFDQUFxQyxNQUFNO0FBQzVDLFdBQU8sTUFBTSxhQUFhLElBQUksRUFBRSxHQUFHLEtBQUs7QUFBQSxFQUMxQyxDQUFDO0FBQ0gsQ0FBQztBQUlELFNBQVMseUJBQXlCLE1BQU07QUFDdEMsS0FBRyxtQ0FBbUMsTUFBTTtBQUMxQyxXQUFPLGFBQWEsTUFBTTtBQUN4Qiw0QkFBc0I7QUFBQSxRQUNwQixPQUFPO0FBQUEsUUFDUCxVQUFVO0FBQUEsUUFDVixVQUFVO0FBQUEsTUFDWixDQUFDO0FBQUEsSUFDSCxDQUFDO0FBQUEsRUFDSCxDQUFDO0FBRUQsS0FBRyw4QkFBOEIsTUFBTTtBQUNyQyxXQUFPO0FBQUEsTUFDTCxNQUFNLHNCQUFzQixNQUFTO0FBQUEsTUFDckMsQ0FBQyxRQUFlO0FBQ2QsZUFBTyxHQUFHLElBQUksUUFBUSxTQUFTLFdBQVcsQ0FBQztBQUMzQyxlQUFPO0FBQUEsTUFDVDtBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFFRCxLQUFHLDJCQUEyQixNQUFNO0FBQ2xDLFdBQU87QUFBQSxNQUNMLE1BQU0sc0JBQXNCLEVBQUUsT0FBTyxJQUFJLFVBQVUsTUFBTSxVQUFVLEtBQUssQ0FBQztBQUFBLE1BQ3pFLENBQUMsUUFBZTtBQUNkLGVBQU8sR0FBRyxJQUFJLFFBQVEsU0FBUyxPQUFPLENBQUM7QUFDdkMsZUFBTztBQUFBLE1BQ1Q7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyxtQ0FBbUMsTUFBTTtBQUMxQyxXQUFPO0FBQUEsTUFDTCxNQUFNLHNCQUFzQixFQUFFLE9BQU8sT0FBTyxVQUFVLE1BQU0sVUFBVSxLQUFLLENBQUM7QUFBQSxNQUM1RSxDQUFDLFFBQWU7QUFDZCxlQUFPLEdBQUcsSUFBSSxRQUFRLFNBQVMsT0FBTyxDQUFDO0FBQ3ZDLGVBQU87QUFBQSxNQUNUO0FBQUEsSUFDRjtBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsOEJBQThCLE1BQU07QUFDckMsV0FBTztBQUFBLE1BQ0wsTUFBTSxzQkFBc0IsRUFBRSxPQUFPLE9BQU8sVUFBVSxJQUFJLFVBQVUsS0FBSyxDQUFDO0FBQUEsTUFDMUUsQ0FBQyxRQUFlO0FBQ2QsZUFBTyxHQUFHLElBQUksUUFBUSxTQUFTLFVBQVUsQ0FBQztBQUMxQyxlQUFPO0FBQUEsTUFDVDtBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFFRCxLQUFHLDhCQUE4QixNQUFNO0FBQ3JDLFdBQU87QUFBQSxNQUNMLE1BQU0sc0JBQXNCLEVBQUUsT0FBTyxPQUFPLFVBQVUsTUFBTSxVQUFVLEdBQUcsQ0FBQztBQUFBLE1BQzFFLENBQUMsUUFBZTtBQUNkLGVBQU8sR0FBRyxJQUFJLFFBQVEsU0FBUyxVQUFVLENBQUM7QUFDMUMsZUFBTztBQUFBLE1BQ1Q7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQztBQUlELFNBQVMsOEJBQThCLE1BQU07QUFDM0MsS0FBRyw0REFBNEQsWUFBWTtBQUN6RSxVQUFNLE1BQU0sT0FBTztBQUNuQixnQkFBWSxLQUFLLEdBQUc7QUFDcEIsVUFBTSxVQUFVLEtBQUssS0FBSyxnQkFBZ0I7QUFFMUMsVUFBTSxTQUF1QjtBQUFBLE1BQzNCLFNBQVM7QUFBQSxNQUNULFVBQVUsRUFBRSxZQUFZLENBQUMsRUFBRTtBQUFBLE1BQzNCLEtBQUssRUFBRSxNQUFNLFNBQVMsT0FBTyxTQUFTLGFBQWEsR0FBRztBQUFBLElBQ3hEO0FBRUEsVUFBTSxTQUFTLElBQUksT0FBTyxFQUFFLFVBQVUsU0FBUyxPQUFPLFFBQVEsQ0FBQztBQUMvRCxVQUFNLFNBQVMsSUFBSSxPQUFPLFFBQVEsTUFBTTtBQUV4QyxVQUFNLE9BQU8sTUFBTTtBQUVuQixVQUFNLFdBQVcsUUFBUTtBQUV6QixZQUFRLE9BQU8sTUFBTTtBQUFBLElBQUM7QUFDdEIsUUFBSTtBQUNGLFlBQU0sT0FBTyxTQUFTO0FBQUEsSUFDeEIsVUFBRTtBQUNBLGNBQVEsT0FBTztBQUFBLElBQ2pCO0FBRUEsVUFBTSxVQUFVLGFBQWEsU0FBUyxPQUFPO0FBRTdDLFdBQU8sR0FBRyxDQUFDLFFBQVEsU0FBUyxXQUFXLENBQUM7QUFDeEMsV0FBTyxHQUFHLENBQUMsUUFBUSxTQUFTLDBCQUEwQixDQUFDO0FBQ3ZELFdBQU8sR0FBRyxDQUFDLFFBQVEsU0FBUyxlQUFlLENBQUM7QUFBQSxFQUM5QyxDQUFDO0FBRUQsS0FBRyw4RUFBOEUsWUFBWTtBQUMzRixVQUFNLE1BQU0sT0FBTztBQUNuQixnQkFBWSxLQUFLLEdBQUc7QUFDcEIsVUFBTSxVQUFVLEtBQUssS0FBSyxlQUFlO0FBRXpDLFVBQU0sU0FBdUI7QUFBQSxNQUMzQixTQUFTO0FBQUEsUUFDUCxPQUFPO0FBQUEsUUFDUCxVQUFVO0FBQUEsUUFDVixVQUFVO0FBQUEsTUFDWjtBQUFBLE1BQ0EsVUFBVSxFQUFFLFlBQVksQ0FBQyxFQUFFO0FBQUEsTUFDM0IsS0FBSyxFQUFFLE1BQU0sU0FBUyxPQUFPLFNBQVMsYUFBYSxHQUFHO0FBQUEsSUFDeEQ7QUFFQSxVQUFNLFNBQVMsSUFBSSxPQUFPLEVBQUUsVUFBVSxTQUFTLE9BQU8sUUFBUSxDQUFDO0FBQy9ELFVBQU0sU0FBUyxJQUFJLE9BQU8sUUFBUSxNQUFNO0FBR3hDLFVBQU0sT0FBTyxNQUFNO0FBRW5CLFVBQU0sV0FBVyxRQUFRO0FBRXpCLFlBQVEsT0FBTyxNQUFNO0FBQUEsSUFBQztBQUN0QixRQUFJO0FBQ0YsWUFBTSxPQUFPLFNBQVM7QUFBQSxJQUN4QixVQUFFO0FBQ0EsY0FBUSxPQUFPO0FBQUEsSUFDakI7QUFHQSxVQUFNLElBQUksUUFBUSxDQUFDLE1BQU0sV0FBVyxHQUFHLEVBQUUsQ0FBQztBQUUxQyxVQUFNLFVBQVUsYUFBYSxTQUFTLE9BQU87QUFFN0MsV0FBTyxHQUFHLFFBQVEsU0FBUywwQkFBMEIsR0FBRyw4QkFBOEI7QUFFdEYsV0FBTyxHQUFHLENBQUMsUUFBUSxTQUFTLG9DQUFvQyxHQUFHLCtCQUErQjtBQUFBLEVBQ3BHLENBQUM7QUFFRCxLQUFHLDJEQUEyRCxZQUFZO0FBQ3hFLFVBQU0sTUFBTSxPQUFPO0FBQ25CLGdCQUFZLEtBQUssR0FBRztBQUNwQixVQUFNLFVBQVUsS0FBSyxLQUFLLGNBQWM7QUFHeEMsVUFBTSxTQUF1QjtBQUFBLE1BQzNCLFNBQVM7QUFBQSxRQUNQLE9BQU87QUFBQSxRQUNQLFVBQVU7QUFBQSxRQUNWLFVBQVU7QUFBQSxNQUNaO0FBQUEsTUFDQSxVQUFVLEVBQUUsWUFBWSxDQUFDLEVBQUU7QUFBQSxNQUMzQixLQUFLLEVBQUUsTUFBTSxTQUFTLE9BQU8sU0FBUyxhQUFhLEdBQUc7QUFBQSxJQUN4RDtBQUVBLFVBQU0sU0FBUyxJQUFJLE9BQU8sRUFBRSxVQUFVLFNBQVMsT0FBTyxRQUFRLENBQUM7QUFDL0QsVUFBTSxTQUFTLElBQUksT0FBTyxRQUFRLE1BQU07QUFFeEMsVUFBTSxPQUFPLE1BQU07QUFFbkIsVUFBTSxXQUFXLFFBQVE7QUFFekIsWUFBUSxPQUFPLE1BQU07QUFBQSxJQUFDO0FBQ3RCLFFBQUk7QUFDRixZQUFNLE9BQU8sU0FBUztBQUFBLElBQ3hCLFVBQUU7QUFDQSxjQUFRLE9BQU87QUFBQSxJQUNqQjtBQUVBLFVBQU0sVUFBVSxhQUFhLFNBQVMsT0FBTztBQUU3QyxXQUFPLEdBQUcsQ0FBQyxRQUFRLFNBQVMsMEJBQTBCLENBQUM7QUFDdkQsV0FBTyxHQUFHLENBQUMsUUFBUSxTQUFTLFdBQVcsQ0FBQztBQUFBLEVBQzFDLENBQUM7QUFDSCxDQUFDO0FBSUQsU0FBUyx1QkFBdUIsTUFBTTtBQUNwQyxLQUFHLDRDQUE0QyxNQUFNO0FBQ25ELFdBQU8sTUFBTSxvQkFBb0IsdUJBQXVCLEdBQUcsZ0JBQWdCO0FBQUEsRUFDN0UsQ0FBQztBQUVELEtBQUcsb0RBQW9ELE1BQU07QUFDM0QsV0FBTyxNQUFNLG9CQUFvQiwrQkFBK0IsR0FBRyx3QkFBd0I7QUFBQSxFQUM3RixDQUFDO0FBRUQsS0FBRywwQ0FBMEMsTUFBTTtBQUNqRCxVQUFNLFdBQVcsSUFBSSxPQUFPLEdBQUc7QUFDL0IsVUFBTSxTQUFTLG9CQUFvQixTQUFTLFFBQVEsRUFBRTtBQUN0RCxXQUFPLEdBQUcsT0FBTyxVQUFVLEtBQUssOEJBQThCLE9BQU8sTUFBTSxFQUFFO0FBQzdFLFdBQU8sR0FBRyxPQUFPLFdBQVcsTUFBTSxDQUFDO0FBQUEsRUFDckMsQ0FBQztBQUVELEtBQUcsZ0RBQWdELE1BQU07QUFDdkQsV0FBTyxNQUFNLG9CQUFvQiwyQkFBMkIsR0FBRyxhQUFhO0FBQUEsRUFDOUUsQ0FBQztBQUVELEtBQUcsMENBQTBDLE1BQU07QUFDakQsV0FBTyxNQUFNLG9CQUFvQixFQUFFLEdBQUcsYUFBYTtBQUNuRCxXQUFPLE1BQU0sb0JBQW9CLEdBQUcsR0FBRyxhQUFhO0FBQUEsRUFDdEQsQ0FBQztBQUVELEtBQUcsNERBQTRELE1BQU07QUFDbkUsV0FBTyxNQUFNLG9CQUFvQixXQUFXLEdBQUcsYUFBYTtBQUFBLEVBQzlELENBQUM7QUFFRCxLQUFHLGlDQUFpQyxNQUFNO0FBQ3hDLFdBQU8sTUFBTSxvQkFBb0IsaUJBQWlCLEdBQUcsV0FBVztBQUFBLEVBQ2xFLENBQUM7QUFFRCxLQUFHLHlDQUF5QyxNQUFNO0FBQ2hELFdBQU8sTUFBTSxvQkFBb0IsNEJBQTRCLEdBQUcsZ0JBQWdCO0FBQUEsRUFDbEYsQ0FBQztBQUVELEtBQUcsNERBQTRELE1BQU07QUFFbkUsVUFBTSxTQUFTLElBQUksT0FBTyxFQUFFO0FBQzVCLFVBQU0sU0FBUyxvQkFBb0IsU0FBUyxNQUFNLEVBQUU7QUFDcEQsV0FBTyxNQUFNLE9BQU8sUUFBUSxHQUFHO0FBQy9CLFdBQU8sTUFBTSxRQUFRLE9BQU8sSUFBSSxPQUFPLEVBQUUsQ0FBQyxFQUFFO0FBQUEsRUFDOUMsQ0FBQztBQUVELEtBQUcsb0NBQW9DLE1BQU07QUFDM0MsV0FBTyxNQUFNLG9CQUFvQixXQUFXLEdBQUcsYUFBYTtBQUFBLEVBQzlELENBQUM7QUFDSCxDQUFDO0FBSUQsU0FBUyxrQkFBa0IsTUFBTTtBQUUvQixXQUFTLGtCQUFrQjtBQUN6QixVQUFNLFdBQVcsb0JBQUksSUFBa0c7QUFDdkgsUUFBSSxnQkFBZ0I7QUFFcEIsVUFBTSxZQUFZO0FBQUEsTUFDaEIsSUFBSTtBQUFBO0FBQUEsTUFDSixVQUFVO0FBQUEsUUFDUixPQUFPO0FBQUEsVUFDTCxLQUFLLENBQUMsT0FBZSxTQUFTLElBQUksRUFBRTtBQUFBLFVBQ3BDLE1BQU0sQ0FBQyxPQUE2QjtBQUNsQyx1QkFBVyxNQUFNLFNBQVMsT0FBTyxHQUFHO0FBQ2xDLGtCQUFJLEdBQUcsRUFBRSxFQUFHLFFBQU87QUFBQSxZQUNyQjtBQUNBLG1CQUFPO0FBQUEsVUFDVDtBQUFBLFFBQ0Y7QUFBQSxRQUNBLFFBQVEsT0FBTyxTQUF3RjtBQUNyRztBQUNBLGdCQUFNLEtBQUssUUFBUSxhQUFhO0FBQ2hDLGdCQUFNLEtBQUs7QUFBQSxZQUNUO0FBQUEsWUFDQSxNQUFNLEtBQUs7QUFBQSxZQUNYLE1BQU0sS0FBSztBQUFBLFlBQ1gsVUFBVSxLQUFLLFVBQVU7QUFBQSxZQUN6QixNQUFNLE9BQU8sYUFBa0I7QUFFN0IsaUJBQUcsV0FBVyxTQUFTLFVBQVUsR0FBRztBQUNwQyxxQkFBTztBQUFBLFlBQ1Q7QUFBQSxVQUNGO0FBQ0EsbUJBQVMsSUFBSSxJQUFJLEVBQUU7QUFDbkIsaUJBQU87QUFBQSxRQUNUO0FBQUEsTUFDRjtBQUFBLE1BQ0EsV0FBVztBQUFBO0FBQUEsTUFDWCxpQkFBaUIsTUFBTTtBQUFBLElBQ3pCO0FBRUEsV0FBTztBQUFBLEVBQ1Q7QUFFQSxXQUFTLG1CQUFtQjtBQUMxQixVQUFNLFVBQXdELENBQUM7QUFDL0QsV0FBTztBQUFBLE1BQ0wsT0FBTyxDQUFDLEtBQWEsU0FBZSxRQUFRLEtBQUssRUFBRSxPQUFPLFNBQVMsS0FBSyxLQUFLLENBQUM7QUFBQSxNQUM5RSxNQUFNLENBQUMsS0FBYSxTQUFlLFFBQVEsS0FBSyxFQUFFLE9BQU8sUUFBUSxLQUFLLEtBQUssQ0FBQztBQUFBLE1BQzVFLE1BQU0sQ0FBQyxLQUFhLFNBQWUsUUFBUSxLQUFLLEVBQUUsT0FBTyxRQUFRLEtBQUssS0FBSyxDQUFDO0FBQUEsTUFDNUUsT0FBTyxDQUFDLEtBQWEsU0FBZSxRQUFRLEtBQUssRUFBRSxPQUFPLFNBQVMsS0FBSyxLQUFLLENBQUM7QUFBQSxNQUM5RTtBQUFBLE1BQ0EsT0FBTyxZQUFZO0FBQUEsTUFBQztBQUFBLElBQ3RCO0FBQUEsRUFDRjtBQUVBLEtBQUcsbURBQW1ELFlBQVk7QUFDaEUsVUFBTSxRQUFRLGdCQUFnQjtBQUM5QixVQUFNLFNBQVMsaUJBQWlCO0FBQ2hDLFVBQU0sTUFBTSxJQUFJLGVBQWUsRUFBRSxPQUFxQixPQUFzQixDQUFDO0FBRTdFLFVBQU0sTUFBTSxNQUFNLElBQUksZ0JBQWdCO0FBQ3RDLFdBQU8sTUFBTSxJQUFJLE1BQU0sY0FBYztBQUNyQyxXQUFPLE1BQU0sSUFBSSxNQUFNLFlBQVksYUFBYTtBQUFBLEVBQ2xELENBQUM7QUFFRCxLQUFHLDBEQUEwRCxZQUFZO0FBQ3ZFLFVBQU0sUUFBUSxnQkFBZ0I7QUFDOUIsVUFBTSxTQUFTLGlCQUFpQjtBQUNoQyxVQUFNLE1BQU0sSUFBSSxlQUFlLEVBQUUsT0FBcUIsT0FBc0IsQ0FBQztBQUU3RSxVQUFNLE9BQU8sTUFBTSxJQUFJLGdCQUFnQjtBQUN2QyxVQUFNLE9BQU8sTUFBTSxJQUFJLGdCQUFnQjtBQUN2QyxXQUFPLE1BQU0sS0FBSyxJQUFJLEtBQUssRUFBRTtBQUU3QixXQUFPLE1BQU0sTUFBTSxnQkFBZ0IsR0FBRyxDQUFDO0FBQUEsRUFDekMsQ0FBQztBQUVELEtBQUcsbURBQW1ELFlBQVk7QUFDaEUsVUFBTSxRQUFRLGdCQUFnQjtBQUU5QixVQUFNLFVBQVUsSUFBSSxnQkFBZ0I7QUFBQSxNQUNsQyxJQUFJO0FBQUEsTUFDSixNQUFNO0FBQUEsTUFDTixNQUFNLFlBQVk7QUFBQSxNQUNsQixVQUFVO0FBQUEsSUFDWixDQUFDO0FBRUQsVUFBTSxTQUFTLGlCQUFpQjtBQUNoQyxVQUFNLE1BQU0sSUFBSSxlQUFlLEVBQUUsT0FBcUIsT0FBc0IsQ0FBQztBQUU3RSxVQUFNLE1BQU0sTUFBTSxJQUFJLGdCQUFnQjtBQUN0QyxXQUFPLE1BQU0sSUFBSSxJQUFJLGNBQWM7QUFFbkMsV0FBTyxNQUFNLE1BQU0sZ0JBQWdCLEdBQUcsQ0FBQztBQUFBLEVBQ3pDLENBQUM7QUFFRCxLQUFHLDREQUE0RCxZQUFZO0FBQ3pFLFVBQU0sUUFBUSxnQkFBZ0I7QUFDOUIsVUFBTSxTQUFTLGlCQUFpQjtBQUNoQyxVQUFNLE1BQU0sSUFBSSxlQUFlLEVBQUUsT0FBcUIsT0FBc0IsQ0FBQztBQUU3RSxVQUFNLFVBQVUsTUFBTSxJQUFJLHFCQUFxQix1QkFBdUI7QUFDdEUsV0FBTyxNQUFNLFFBQVEsTUFBTSxnQkFBZ0I7QUFDM0MsV0FBTyxNQUFNLFFBQVEsTUFBTSxZQUFZLFNBQVM7QUFFaEQsV0FBTyxNQUFNLFFBQVEsVUFBVSxRQUFRO0FBQUEsRUFDekMsQ0FBQztBQUVELEtBQUcsb0RBQW9ELFlBQVk7QUFDakUsVUFBTSxRQUFRLGdCQUFnQjtBQUM5QixVQUFNLFNBQVMsaUJBQWlCO0FBQ2hDLFVBQU0sTUFBTSxJQUFJLGVBQWUsRUFBRSxPQUFxQixPQUFzQixDQUFDO0FBRzdFLFVBQU0sVUFBVSxNQUFNLElBQUkscUJBQXFCLG9CQUFvQjtBQUNuRSxVQUFNLFlBQVksUUFBUTtBQUcxQixVQUFNLElBQUksZUFBZSxTQUFTO0FBR2xDLFVBQU0sV0FBVyxNQUFNLFVBQVUsSUFBSSxTQUFTO0FBRTlDLFdBQU8sTUFBTSxTQUFTLFVBQVUsUUFBUTtBQUd4QyxVQUFNLGFBQWEsT0FBTyxRQUFRLEtBQUssQ0FBQyxNQUFNLEVBQUUsUUFBUSxrQkFBa0I7QUFDMUUsV0FBTyxHQUFHLFlBQVksNkJBQTZCO0FBQ25ELFdBQU8sTUFBTSxXQUFZLEtBQUssV0FBVyxTQUFTO0FBQUEsRUFDcEQsQ0FBQztBQUVELEtBQUcsK0NBQStDLFlBQVk7QUFDNUQsVUFBTSxRQUFRLGdCQUFnQjtBQUM5QixVQUFNLFNBQVMsaUJBQWlCO0FBQ2hDLFVBQU0sTUFBTSxJQUFJLGVBQWUsRUFBRSxPQUFxQixPQUFzQixDQUFDO0FBRTdFLFVBQU0sSUFBSSxlQUFlLGdCQUFnQjtBQUN6QyxVQUFNLFVBQVUsT0FBTyxRQUFRLEtBQUssQ0FBQyxNQUFNLEVBQUUsUUFBUSwwQkFBMEI7QUFDL0UsV0FBTyxHQUFHLFNBQVMsbUNBQW1DO0FBQUEsRUFDeEQsQ0FBQztBQUVELEtBQUcsMkNBQTJDLFlBQVk7QUFDeEQsVUFBTSxRQUFRLGdCQUFnQjtBQUM5QixVQUFNLFNBQVMsaUJBQWlCO0FBQ2hDLFVBQU0sTUFBTSxJQUFJLGVBQWU7QUFBQSxNQUM3QjtBQUFBLE1BQ0E7QUFBQSxNQUNBLGNBQWM7QUFBQSxJQUNoQixDQUFDO0FBRUQsVUFBTSxNQUFNLE1BQU0sSUFBSSxnQkFBZ0I7QUFDdEMsV0FBTyxNQUFNLElBQUksTUFBTSxpQkFBaUI7QUFBQSxFQUMxQyxDQUFDO0FBQ0gsQ0FBQztBQUlELFNBQVMsaUJBQWlCLE1BQU07QUFDOUIsS0FBRyw0Q0FBNEMsTUFBTTtBQUNuRCxVQUFNLFdBQVcsY0FBYztBQUMvQixXQUFPLE1BQU0sU0FBUyxRQUFRLENBQUM7QUFDL0IsVUFBTSxRQUFRLFNBQVMsSUFBSSxDQUFDLE1BQU0sRUFBRSxJQUFJO0FBQ3hDLFdBQU8sR0FBRyxNQUFNLFNBQVMsWUFBWSxHQUFHLDJCQUEyQjtBQUNuRSxXQUFPLEdBQUcsTUFBTSxTQUFTLFdBQVcsR0FBRywwQkFBMEI7QUFDakUsV0FBTyxHQUFHLE1BQU0sU0FBUyxVQUFVLEdBQUcseUJBQXlCO0FBQy9ELFdBQU8sR0FBRyxNQUFNLFNBQVMsYUFBYSxHQUFHLDRCQUE0QjtBQUFBLEVBQ3ZFLENBQUM7QUFFRCxLQUFHLGtDQUFrQyxNQUFNO0FBQ3pDLFVBQU0sV0FBVyxjQUFjO0FBQy9CLGVBQVcsT0FBTyxVQUFVO0FBQzFCLGFBQU8sR0FBRyxJQUFJLGFBQWEsV0FBVyxJQUFJLElBQUksNEJBQTRCO0FBQzFFLGFBQU8sR0FBRyxJQUFJLFlBQVksU0FBUyxHQUFHLFdBQVcsSUFBSSxJQUFJLGtDQUFrQztBQUFBLElBQzdGO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQztBQUlELFNBQVMsdUJBQXVCLE1BQU07QUFDcEMsV0FBUyxZQUFZLFlBQXFDLENBQUMsR0FBbUI7QUFDNUUsV0FBTztBQUFBLE1BQ0wsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLE1BQ1osYUFBYTtBQUFBLE1BQ2IsUUFBUTtBQUFBLE1BQ1IsUUFBUSxDQUFDO0FBQUEsTUFDVCxRQUFRLENBQUM7QUFBQSxNQUNULGdCQUFnQjtBQUFBLE1BQ2hCLE1BQU0sRUFBRSxXQUFXLFFBQVEsUUFBUSxFQUFFLE9BQU8sS0FBSyxRQUFRLElBQUksV0FBVyxHQUFHLFlBQVksRUFBRSxFQUFFO0FBQUEsTUFDM0YsV0FBVyxLQUFLLElBQUksSUFBSTtBQUFBO0FBQUEsTUFDeEIsR0FBRztBQUFBLElBQ0w7QUFBQSxFQUNGO0FBRUEsS0FBRyxpREFBaUQsTUFBTTtBQUN4RCxXQUFPLE1BQU0sb0JBQW9CLENBQUMsQ0FBQyxHQUFHLHFCQUFxQjtBQUFBLEVBQzdELENBQUM7QUFFRCxLQUFHLHVEQUF1RCxNQUFNO0FBQzlELFVBQU0sU0FBUyxvQkFBb0IsQ0FBQyxZQUFZLENBQUMsQ0FBQztBQUNsRCxXQUFPLEdBQUcsT0FBTyxTQUFTLFNBQVMsR0FBRyw2QkFBNkI7QUFDbkUsV0FBTyxHQUFHLE9BQU8sU0FBUyxTQUFTLEdBQUcsdUJBQXVCO0FBQzdELFdBQU8sR0FBRyxPQUFPLFNBQVMsR0FBRyxHQUFHLHFCQUFxQjtBQUFBLEVBQ3ZELENBQUM7QUFFRCxLQUFHLCtDQUErQyxNQUFNO0FBQ3RELFVBQU0sV0FBVztBQUFBLE1BQ2YsWUFBWSxFQUFFLGFBQWEsU0FBUyxRQUFRLFVBQVUsQ0FBQztBQUFBLE1BQ3ZELFlBQVksRUFBRSxhQUFhLFFBQVEsUUFBUSxVQUFVLENBQUM7QUFBQSxJQUN4RDtBQUNBLFVBQU0sU0FBUyxvQkFBb0IsUUFBUTtBQUMzQyxXQUFPLEdBQUcsT0FBTyxTQUFTLE9BQU8sR0FBRyw4QkFBOEI7QUFDbEUsV0FBTyxHQUFHLE9BQU8sU0FBUyxNQUFNLEdBQUcsK0JBQStCO0FBQ2xFLFVBQU0sUUFBUSxPQUFPLE1BQU0sSUFBSTtBQUMvQixXQUFPLE1BQU0sTUFBTSxRQUFRLEdBQUcsa0NBQWtDO0FBQUEsRUFDbEUsQ0FBQztBQUVELEtBQUcsZ0NBQWdDLE1BQU07QUFDdkMsVUFBTSxXQUFXLE1BQU07QUFBQSxNQUFLLEVBQUUsUUFBUSxFQUFFO0FBQUEsTUFBRyxDQUFDLEdBQUcsTUFDN0MsWUFBWSxFQUFFLGFBQWEsUUFBUSxDQUFDLElBQUksUUFBUSxJQUFJLE1BQU0sSUFBSSxZQUFZLFlBQVksQ0FBQztBQUFBLElBQ3pGO0FBQ0EsVUFBTSxTQUFTLG9CQUFvQixRQUFRO0FBQzNDLFVBQU0sUUFBUSxPQUFPLE1BQU0sSUFBSTtBQUMvQixXQUFPLE1BQU0sTUFBTSxRQUFRLENBQUM7QUFDNUIsYUFBUyxJQUFJLEdBQUcsSUFBSSxHQUFHLEtBQUs7QUFDMUIsYUFBTyxHQUFHLE1BQU0sQ0FBQyxFQUFFLFNBQVMsUUFBUSxDQUFDLEVBQUUsQ0FBQztBQUFBLElBQzFDO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQztBQUlELFNBQVMsb0JBQW9CLE1BQU07QUFFakMsV0FBUyxnQkFBZ0IsYUFBcUIsU0FBaUIsV0FBVztBQUN4RSxRQUFJLFVBQVU7QUFDZCxRQUFJLGVBQWU7QUFFbkIsV0FBTztBQUFBLE1BQ0wsTUFBTSxFQUFFLElBQUksT0FBTztBQUFBLE1BQ25CLE1BQU07QUFBQTtBQUFBLE1BQ04sb0JBQW9CLE1BQU07QUFBQSxNQUMxQjtBQUFBLE1BQ0EsT0FBTyxPQUFPLFNBQW1EO0FBQy9ELGtCQUFVO0FBQ1YsdUJBQWUsS0FBSztBQUFBLE1BQ3RCO0FBQUEsTUFDQSxhQUFhLE1BQU07QUFBQSxNQUNuQixrQkFBa0IsTUFBTTtBQUFBLElBQzFCO0FBQUEsRUFDRjtBQUdBLFdBQVMsMEJBQTBCLFNBQWlCLFdBQVc7QUFDN0QsUUFBSSxVQUFVO0FBQ2QsV0FBTztBQUFBLE1BQ0wsTUFBTSxFQUFFLElBQUksT0FBTztBQUFBLE1BQ25CLE1BQU07QUFBQTtBQUFBLE1BQ04sb0JBQW9CLE1BQU07QUFBQSxNQUMxQixhQUFhLE1BQU07QUFBQSxJQUNyQjtBQUFBLEVBQ0Y7QUFRQSxLQUFHLHNEQUFzRCxNQUFNO0FBRTdELFVBQU0sU0FBUyxvQkFBb0IsQ0FBQyxDQUFDO0FBQ3JDLFdBQU8sTUFBTSxRQUFRLHFCQUFxQjtBQUFBLEVBQzVDLENBQUM7QUFFRCxLQUFHLHFEQUFxRCxNQUFNO0FBQzVELFVBQU0sV0FBVyxjQUFjO0FBQy9CLFVBQU0sUUFBUSxTQUFTLElBQUksQ0FBQyxNQUFNLEVBQUUsSUFBSTtBQUN4QyxXQUFPLEdBQUcsQ0FBQyxNQUFNLFNBQVMsYUFBYSxHQUFHLHVDQUF1QztBQUFBLEVBQ25GLENBQUM7QUFFRCxLQUFHLCtDQUErQyxNQUFNO0FBRXRELFVBQU0sYUFBYSxhQUFhLGdCQUFnQixTQUFTO0FBQ3pELFdBQU8sTUFBTSxZQUFZLEtBQUs7QUFBQSxFQUNoQyxDQUFDO0FBRUQsS0FBRywyQ0FBMkMsTUFBTTtBQUNsRCxVQUFNLGFBQWEsYUFBYSxXQUFXLFNBQVM7QUFDcEQsV0FBTyxNQUFNLFlBQVksSUFBSTtBQUFBLEVBQy9CLENBQUM7QUFDSCxDQUFDO0FBSUQsU0FBUyw2REFBd0QsTUFBTTtBQUNyRSxLQUFHLGdEQUFnRCxNQUFNO0FBQ3ZELFVBQU0sU0FBUyxlQUFlO0FBQUEsTUFDNUIsU0FBUztBQUFBLFFBQ1AsT0FBTztBQUFBLFFBQ1AsVUFBVTtBQUFBLFFBQ1YsVUFBVTtBQUFBLFFBQ1Ysb0JBQW9CO0FBQUEsTUFDdEI7QUFBQSxJQUNGLENBQUM7QUFDRCxXQUFPLE1BQU0sT0FBTyxTQUFTLG9CQUFvQixRQUFRO0FBQUEsRUFDM0QsQ0FBQztBQUVELEtBQUcsNkNBQTZDLE1BQU07QUFDcEQsVUFBTSxTQUFTLGVBQWU7QUFBQSxNQUM1QixTQUFTO0FBQUEsUUFDUCxPQUFPO0FBQUEsUUFDUCxVQUFVO0FBQUEsUUFDVixVQUFVO0FBQUEsTUFDWjtBQUFBLElBQ0YsQ0FBQztBQUNELFdBQU8sTUFBTSxPQUFPLFNBQVMsb0JBQW9CLE1BQVM7QUFBQSxFQUM1RCxDQUFDO0FBRUQsS0FBRyw0Q0FBNEMsTUFBTTtBQUNuRCxVQUFNLFNBQVMsZUFBZTtBQUFBLE1BQzVCLFNBQVM7QUFBQSxRQUNQLE9BQU87QUFBQSxRQUNQLFVBQVU7QUFBQSxRQUNWLFVBQVU7QUFBQSxRQUNWLGNBQWMsRUFBRSxPQUFPLG9CQUFvQixZQUFZLEtBQUs7QUFBQSxNQUM5RDtBQUFBLElBQ0YsQ0FBQztBQUNELFdBQU8sTUFBTSxPQUFPLFNBQVMsY0FBYyxPQUFPLGtCQUFrQjtBQUNwRSxXQUFPLE1BQU0sT0FBTyxTQUFTLGNBQWMsWUFBWSxJQUFJO0FBQUEsRUFDN0QsQ0FBQztBQUVELEtBQUcsbURBQW1ELE1BQU07QUFDMUQsVUFBTSxTQUFTLGVBQWU7QUFBQSxNQUM1QixTQUFTO0FBQUEsUUFDUCxPQUFPO0FBQUEsUUFDUCxVQUFVO0FBQUEsUUFDVixVQUFVO0FBQUEsTUFDWjtBQUFBLElBQ0YsQ0FBQztBQUNELFdBQU8sTUFBTSxPQUFPLFNBQVMsY0FBYyxNQUFTO0FBQUEsRUFDdEQsQ0FBQztBQUVELEtBQUcsdURBQXVELE1BQU07QUFDOUQsVUFBTSxTQUFTLGVBQWU7QUFBQSxNQUM1QixTQUFTO0FBQUEsUUFDUCxPQUFPO0FBQUEsUUFDUCxVQUFVO0FBQUEsUUFDVixVQUFVO0FBQUEsUUFDVixjQUFjLENBQUM7QUFBQSxNQUNqQjtBQUFBLElBQ0YsQ0FBQztBQUVELFdBQU8sR0FBRyxPQUFPLFNBQVMsaUJBQWlCLE1BQVM7QUFDcEQsV0FBTyxNQUFNLE9BQU8sU0FBUyxjQUFjLE9BQU8sTUFBUztBQUMzRCxXQUFPLE1BQU0sT0FBTyxTQUFTLGNBQWMsWUFBWSxNQUFTO0FBQUEsRUFDbEUsQ0FBQztBQUVELEtBQUcsa0NBQWtDLE1BQU07QUFDekMsVUFBTSxTQUFTLGVBQWU7QUFBQSxNQUM1QixTQUFTO0FBQUEsUUFDUCxPQUFPO0FBQUEsUUFDUCxVQUFVO0FBQUEsUUFDVixVQUFVO0FBQUEsUUFDVixjQUFjLEVBQUUsWUFBWSxlQUFlO0FBQUEsTUFDN0M7QUFBQSxJQUNGLENBQUM7QUFDRCxXQUFPLE1BQU0sT0FBTyxTQUFTLGNBQWMsWUFBWSxNQUFTO0FBQUEsRUFDbEUsQ0FBQztBQUVELEtBQUcsNEJBQTRCLE1BQU07QUFDbkMsVUFBTSxTQUFTLGVBQWU7QUFBQSxNQUM1QixTQUFTO0FBQUEsUUFDUCxPQUFPO0FBQUEsUUFDUCxVQUFVO0FBQUEsUUFDVixVQUFVO0FBQUEsUUFDVixjQUFjLEVBQUUsT0FBTyxHQUFHO0FBQUEsTUFDNUI7QUFBQSxJQUNGLENBQUM7QUFDRCxXQUFPLE1BQU0sT0FBTyxTQUFTLGNBQWMsT0FBTyxNQUFTO0FBQUEsRUFDN0QsQ0FBQztBQUNILENBQUM7QUFJRCxTQUFTLDhCQUE4QixNQUFNO0FBQzNDLEtBQUcsZ0VBQWdFLFlBQVk7QUFDN0UsVUFBTSxNQUFNLE9BQU87QUFDbkIsZ0JBQVksS0FBSyxHQUFHO0FBQ3BCLFVBQU0sVUFBVSxLQUFLLEtBQUsscUJBQXFCO0FBRS9DLFVBQU0sU0FBdUI7QUFBQSxNQUMzQixTQUFTO0FBQUEsTUFDVCxVQUFVLEVBQUUsWUFBWSxDQUFDLEVBQUU7QUFBQSxNQUMzQixLQUFLLEVBQUUsTUFBTSxTQUFTLE9BQU8sU0FBUyxhQUFhLEdBQUc7QUFBQSxJQUN4RDtBQUVBLFVBQU0sU0FBUyxJQUFJLE9BQU8sRUFBRSxVQUFVLFNBQVMsT0FBTyxRQUFRLENBQUM7QUFDL0QsVUFBTSxTQUFTLElBQUksT0FBTyxRQUFRLE1BQU07QUFFeEMsVUFBTSxPQUFPLE1BQU07QUFDbkIsV0FBTyxNQUFNLE9BQU8sZ0JBQWdCLEdBQUcsTUFBUztBQUVoRCxVQUFNLFdBQVcsUUFBUTtBQUV6QixZQUFRLE9BQU8sTUFBTTtBQUFBLElBQUM7QUFDdEIsUUFBSTtBQUNGLFlBQU0sT0FBTyxTQUFTO0FBQUEsSUFDeEIsVUFBRTtBQUNBLGNBQVEsT0FBTztBQUFBLElBQ2pCO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyxvRUFBb0UsWUFBWTtBQUdqRixVQUFNLE1BQU0sT0FBTztBQUNuQixnQkFBWSxLQUFLLEdBQUc7QUFDcEIsVUFBTSxVQUFVLEtBQUssS0FBSyxpQkFBaUI7QUFFM0MsVUFBTSxTQUF1QjtBQUFBLE1BQzNCLFNBQVM7QUFBQSxRQUNQLE9BQU87QUFBQSxRQUNQLFVBQVU7QUFBQSxRQUNWLFVBQVU7QUFBQTtBQUFBLE1BRVo7QUFBQSxNQUNBLFVBQVUsRUFBRSxZQUFZLENBQUMsRUFBRTtBQUFBLE1BQzNCLEtBQUssRUFBRSxNQUFNLFNBQVMsT0FBTyxTQUFTLGFBQWEsR0FBRztBQUFBLElBQ3hEO0FBRUEsVUFBTSxTQUFTLElBQUksT0FBTyxFQUFFLFVBQVUsU0FBUyxPQUFPLFFBQVEsQ0FBQztBQUMvRCxVQUFNLFNBQVMsSUFBSSxPQUFPLFFBQVEsTUFBTTtBQUV4QyxVQUFNLE9BQU8sTUFBTTtBQUluQixXQUFPLE1BQU0sT0FBTyxnQkFBZ0IsR0FBRyxNQUFTO0FBRWhELFVBQU0sV0FBVyxRQUFRO0FBRXpCLFlBQVEsT0FBTyxNQUFNO0FBQUEsSUFBQztBQUN0QixRQUFJO0FBQ0YsWUFBTSxPQUFPLFNBQVM7QUFBQSxJQUN4QixVQUFFO0FBQ0EsY0FBUSxPQUFPO0FBQUEsSUFDakI7QUFBQSxFQUNGLENBQUM7QUFDSCxDQUFDO0FBSUQsU0FBUyxrQ0FBa0MsTUFBTTtBQUsvQyxLQUFHLG9EQUFvRCxZQUFZO0FBRWpFLFVBQU0sRUFBRSxnQkFBZ0IsSUFBSSxNQUFNLE9BQU8sc0JBQXNCO0FBRS9ELFVBQU0sV0FBVyxNQUFNLGdCQUFnQixDQUFDLENBQUM7QUFDekMsV0FBTyxNQUFNLFNBQVMsUUFBUSxDQUFDO0FBQUEsRUFDakMsQ0FBQztBQUVELEtBQUcsbUVBQW1FLFlBQVk7QUFDaEYsVUFBTSxFQUFFLGVBQWUsSUFBSSxNQUFNLE9BQU8sc0JBQXNCO0FBQzlELFVBQU0sTUFBTSxPQUFPO0FBQ25CLGdCQUFZLEtBQUssR0FBRztBQUNwQixVQUFNLFVBQVUsS0FBSyxLQUFLLGFBQWE7QUFDdkMsVUFBTSxTQUFTLElBQUksT0FBTyxFQUFFLFVBQVUsU0FBUyxPQUFPLFFBQVEsQ0FBQztBQUMvRCxVQUFNLEtBQUssSUFBSSxlQUFlLE1BQU07QUFDcEMsVUFBTSxXQUFXLEdBQUcsZUFBZTtBQUNuQyxXQUFPLE1BQU0sU0FBUyxRQUFRLENBQUM7QUFDL0IsVUFBTSxPQUFPLE1BQU07QUFBQSxFQUNyQixDQUFDO0FBRUQsS0FBRyw4Q0FBOEMsTUFBTTtBQUVyRCxVQUFNLGNBQXlDO0FBQUEsTUFDN0MsRUFBRSxXQUFXLE1BQU0sUUFBUSxXQUFXLGFBQWEsUUFBUTtBQUFBLE1BQzNELEVBQUUsV0FBVyxNQUFNLFFBQVEsYUFBYSxhQUFhLE9BQU87QUFBQSxNQUM1RCxFQUFFLFdBQVcsTUFBTSxRQUFRLFdBQVcsYUFBYSxRQUFRO0FBQUEsTUFDM0QsRUFBRSxXQUFXLE1BQU0sUUFBUSxTQUFTLGFBQWEsUUFBUTtBQUFBLE1BQ3pELEVBQUUsV0FBVyxNQUFNLFFBQVEsWUFBWSxhQUFhLFVBQVU7QUFBQSxNQUM5RCxFQUFFLFdBQVcsTUFBTSxRQUFRLGFBQWEsYUFBYSxPQUFPO0FBQUEsSUFDOUQ7QUFDQSxVQUFNLFNBQVMsWUFBWTtBQUFBLE1BQ3pCLENBQUMsTUFBTSxFQUFFLFdBQVcsYUFBYSxFQUFFLFdBQVcsYUFBYSxFQUFFLFdBQVc7QUFBQSxJQUMxRTtBQUNBLFdBQU8sTUFBTSxPQUFPLFFBQVEsQ0FBQztBQUM3QixXQUFPLFVBQVUsT0FBTyxJQUFJLENBQUMsTUFBTSxFQUFFLFdBQVcsR0FBRyxDQUFDLFNBQVMsU0FBUyxTQUFTLENBQUM7QUFBQSxFQUNsRixDQUFDO0FBRUQsS0FBRywwREFBMEQsTUFBTTtBQUVqRSxVQUFNLFdBQVcsTUFBTSxLQUFLLEVBQUUsUUFBUSxHQUFHLEdBQUcsQ0FBQyxHQUFHLE9BQU87QUFBQSxNQUNyRCxNQUFNLFdBQVcsQ0FBQztBQUFBLE1BQ2xCLE1BQU0sc0JBQXNCLENBQUM7QUFBQSxNQUM3QixTQUFTLENBQUM7QUFBQSxNQUNWLGNBQWMsS0FBSyxJQUFJO0FBQUEsSUFDekIsRUFBRTtBQUNGLFVBQU0sWUFBWSxTQUFTLE1BQU0sR0FBRyxFQUFFO0FBQ3RDLFdBQU8sTUFBTSxVQUFVLFFBQVEsRUFBRTtBQUNqQyxXQUFPLE1BQU0sVUFBVSxFQUFFLEVBQUUsTUFBTSxZQUFZO0FBQUEsRUFDL0MsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
